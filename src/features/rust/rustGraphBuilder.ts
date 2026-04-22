import type {
  Edge,
  RepositoryGraph,
  SymbolContext,
  SymbolKind,
  SymbolNode
} from "../../types/graph";
import type { RustSyntaxParseResult } from "./rustParsingTypes";

import { parseRustSyntaxFile } from "./rustTreeSitterParser";

interface BuildRustFileGraphOptions {
  filePath: string;
  sourceText: string;
  modulePath?: string;
}

interface BuildState {
  filePath: string;
  rootModuleId: string;
  nodes: SymbolNode[];
  edges: Edge[];
  nodesById: Map<string, SymbolNode>;
  edgesSeen: Set<string>;
  externalNodeIds: Map<string, string>;
}

export function buildRustFileGraph(
  options: BuildRustFileGraphOptions
): RepositoryGraph {
  const syntax = parseRustSyntaxFile(options);
  const nodes = [syntax.rootModule, ...syntax.symbols];
  const state: BuildState = {
    filePath: syntax.filePath,
    rootModuleId: syntax.rootModule.id,
    nodes,
    edges: [],
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    edgesSeen: new Set<string>(),
    externalNodeIds: new Map<string, string>()
  };

  connectBelongsToEdges(state);
  connectImplEdges(state, syntax);
  connectImportEdges(state, syntax);
  connectCallEdges(state, syntax);
  connectTypeEdges(state, syntax);

  return {
    language: "rust",
    filePath: syntax.filePath,
    rootModuleId: syntax.rootModule.id,
    nodes: state.nodes,
    edges: state.edges
  };
}

export function findInnermostSymbolAtLine(
  graph: RepositoryGraph,
  lineNumber: number
): SymbolNode | undefined {
  return graph.nodes
    .filter(
      (node) =>
        !node.isExternal &&
        node.id !== graph.rootModuleId &&
        node.span.startLine <= lineNumber &&
        node.span.endLine >= lineNumber
    )
    .sort((left, right) => {
      const leftSpan = left.span.endLine - left.span.startLine;
      const rightSpan = right.span.endLine - right.span.startLine;

      return leftSpan - rightSpan;
    })[0];
}

export function findNearestSymbolByLine(
  graph: RepositoryGraph,
  lineNumber: number
): SymbolNode | undefined {
  return (
    findInnermostSymbolAtLine(graph, lineNumber) ??
    graph.nodes
      .filter(
        (node) =>
          !node.isExternal &&
          node.id !== graph.rootModuleId &&
          node.span.startLine <= lineNumber
      )
      .sort((left, right) => right.span.startLine - left.span.startLine)[0]
  );
}

export function getSymbolContext(
  graph: RepositoryGraph,
  symbolId: string
): SymbolContext | undefined {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const node = nodeById.get(symbolId);

  if (!node) {
    return undefined;
  }

  const parent = node.parentSymbolId ? nodeById.get(node.parentSymbolId) : undefined;
  const outgoingEdges = graph.edges.filter((edge) => edge.from === node.id);
  const incomingEdges = graph.edges.filter((edge) => edge.to === node.id);

  return {
    node,
    parent,
    parents: collectParentChain(nodeById, node),
    children: graph.nodes.filter(
      (candidate) => candidate.parentSymbolId === node.id
    ),
    outgoingEdges,
    incomingEdges,
    callees: collectConnectedNodes(nodeById, outgoingEdges, "calls"),
    callers: collectConnectedNodes(nodeById, incomingEdges, "called_by", true),
    relatedTypes: collectConnectedNodes(nodeById, outgoingEdges, "uses_type"),
    importedSymbols: collectConnectedNodes(nodeById, outgoingEdges, "imports")
  };
}

function connectBelongsToEdges(state: BuildState): void {
  for (const node of state.nodes) {
    if (node.id === state.rootModuleId || !node.parentSymbolId) {
      continue;
    }

    addEdge(state, {
      from: node.id,
      to: node.parentSymbolId,
      kind: "belongs_to"
    });
  }
}

function connectImplEdges(
  state: BuildState,
  syntax: RustSyntaxParseResult
): void {
  for (const binding of syntax.implBindings) {
    const implNode = state.nodesById.get(binding.implSymbolId);

    if (!implNode) {
      continue;
    }

    const targetTypeNode =
      resolveLocalNodeByName(state.nodes, binding.targetTypeName, [
        "struct",
        "enum",
        "trait"
      ]) ??
      ensureExternalNode(
        state,
        binding.targetTypeName,
        guessTypeKind(binding.targetTypeName)
      );

    addEdge(state, {
      from: implNode.id,
      to: targetTypeNode.id,
      kind: "belongs_to"
    });

    if (binding.traitName) {
      const traitNode =
        resolveLocalNodeByName(state.nodes, binding.traitName, ["trait"]) ??
        ensureExternalNode(state, binding.traitName, "trait");

      addEdge(state, {
        from: implNode.id,
        to: traitNode.id,
        kind: "implements"
      });
    }
  }
}

function connectImportEdges(
  state: BuildState,
  syntax: RustSyntaxParseResult
): void {
  for (const binding of syntax.importBindings) {
    for (const importedName of binding.importedNames) {
      const importedNode =
        resolveLocalNodeByName(state.nodes, importedName) ??
        ensureExternalNode(
          state,
          importedName,
          guessImportedSymbolKind(importedName)
        );

      addEdge(state, {
        from: binding.ownerSymbolId,
        to: importedNode.id,
        kind: "imports"
      });
    }
  }
}

function connectCallEdges(
  state: BuildState,
  syntax: RustSyntaxParseResult
): void {
  for (const binding of syntax.callBindings) {
    const targetNode =
      resolveLocalNodeByName(state.nodes, binding.targetName, [
        binding.targetKindHint,
        binding.targetKindHint === "method" ? "function" : "method"
      ]) ??
      ensureExternalNode(state, binding.targetName, binding.targetKindHint);

    addEdge(state, {
      from: binding.ownerSymbolId,
      to: targetNode.id,
      kind: "calls"
    });
    addEdge(state, {
      from: binding.ownerSymbolId,
      to: targetNode.id,
      kind: "called_by"
    });
  }
}

function connectTypeEdges(
  state: BuildState,
  syntax: RustSyntaxParseResult
): void {
  for (const binding of syntax.typeBindings) {
    const resolvedTypeName = resolveSelfTypeName(state, binding) ?? binding.typeName;
    const typeNode =
      resolveLocalNodeByName(state.nodes, resolvedTypeName, [
        "struct",
        "enum",
        "trait"
      ]) ??
      ensureExternalNode(
        state,
        resolvedTypeName,
        guessTypeKind(resolvedTypeName)
      );

    addEdge(state, {
      from: binding.ownerSymbolId,
      to: typeNode.id,
      kind: "uses_type"
    });
  }
}

function ensureExternalNode(
  state: BuildState,
  name: string,
  kind: SymbolKind
): SymbolNode {
  const key = `${kind}:${name}`;
  const existingId = state.externalNodeIds.get(key);

  if (existingId) {
    const existingNode = state.nodesById.get(existingId);

    if (existingNode) {
      return existingNode;
    }
  }

  const node: SymbolNode = {
    id: `rust:external:${kind}:${name}`,
    name,
    kind,
    filePath: state.filePath,
    modulePath: "external",
    span: {
      startLine: 0,
      endLine: 0
    },
    isExternal: true,
    language: "rust"
  };

  state.externalNodeIds.set(key, node.id);
  state.nodes.push(node);
  state.nodesById.set(node.id, node);
  return node;
}

function addEdge(state: BuildState, edge: Edge): void {
  const edgeKey = `${edge.from}|${edge.to}|${edge.kind}`;

  if (state.edgesSeen.has(edgeKey)) {
    return;
  }

  state.edgesSeen.add(edgeKey);
  state.edges.push(edge);
}

function collectParentChain(
  nodeById: Map<string, SymbolNode>,
  node: SymbolNode
): SymbolNode[] {
  const parents: SymbolNode[] = [];
  let currentNode = node.parentSymbolId
    ? nodeById.get(node.parentSymbolId)
    : undefined;

  while (currentNode) {
    parents.push(currentNode);
    currentNode = currentNode.parentSymbolId
      ? nodeById.get(currentNode.parentSymbolId)
      : undefined;
  }

  return parents;
}

function collectConnectedNodes(
  nodeById: Map<string, SymbolNode>,
  edges: Edge[],
  kind: Edge["kind"],
  reverse = false
): SymbolNode[] {
  const nodes = edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => nodeById.get(reverse ? edge.from : edge.to))
    .filter((node): node is SymbolNode => node !== undefined);

  return dedupeNodes(nodes);
}

function dedupeNodes(nodes: SymbolNode[]): SymbolNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }

    seen.add(node.id);
    return true;
  });
}

function resolveLocalNodeByName(
  nodes: SymbolNode[],
  name: string,
  kinds?: SymbolKind[]
): SymbolNode | undefined {
  return nodes.find(
    (node) =>
      !node.isExternal &&
      node.name === name &&
      (kinds === undefined || kinds.includes(node.kind))
  );
}

function resolveSelfTypeName(
  state: BuildState,
  binding: { ownerSymbolId: string; typeName: string }
): string | undefined {
  if (binding.typeName !== "Self") {
    return undefined;
  }

  const ownerNode = state.nodesById.get(binding.ownerSymbolId);
  const parentNode = ownerNode?.parentSymbolId
    ? state.nodesById.get(ownerNode.parentSymbolId)
    : undefined;

  if (!parentNode || parentNode.kind !== "impl") {
    return undefined;
  }

  const implTargetNode = state.edges.find(
    (edge) => edge.from === parentNode.id && edge.kind === "belongs_to"
  );

  if (!implTargetNode) {
    return undefined;
  }

  return state.nodesById.get(implTargetNode.to)?.name;
}

function guessImportedSymbolKind(name: string): SymbolKind {
  return /^[A-Z]/.test(name) ? guessTypeKind(name) : "module";
}

function guessTypeKind(name: string): SymbolKind {
  if (name === "Option" || name === "Result") {
    return "enum";
  }

  return "struct";
}
