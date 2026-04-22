import * as vscode from "vscode";

import type { CargoWorkspaceContext } from "./rustCargoMetadata";
import {
  inferRustModulePath,
  loadCargoWorkspaceContext
} from "./rustCargoMetadata";
import type { RustSyntaxParseResult } from "./rustParsingTypes";
import type { Edge, RepositoryGraph, SymbolKind, SymbolNode } from "../../types/graph";
import type { RustLspSnapshot } from "./rustLspClient";
import { collectRustLspSnapshot } from "./rustLspClient";

export interface RustGraphAugmentationResult {
  graph: RepositoryGraph;
  cargoWorkspace?: CargoWorkspaceContext;
  lspSummary: {
    callHierarchyEdges: number;
    definitionEdges: number;
    referenceEdges: number;
    addedNodes: number;
  };
}

interface MutableGraphState {
  graph: RepositoryGraph;
  nodesById: Map<string, SymbolNode>;
  nodeKeyToId: Map<string, string>;
  edgeKeys: Set<string>;
}

interface SymbolDescriptor {
  name: string;
  kind: SymbolKind;
  filePath: string;
  modulePath: string;
  span: {
    startLine: number;
    endLine: number;
  };
  selectionLine: number;
  selectionCharacter: number;
}

export async function buildRustFileGraphWithLsp(
  document: vscode.TextDocument,
  baseGraph: RepositoryGraph,
  syntax: RustSyntaxParseResult
): Promise<RustGraphAugmentationResult> {
  const graphState = createMutableGraphState(baseGraph);
  const lspSummary = {
    callHierarchyEdges: 0,
    definitionEdges: 0,
    referenceEdges: 0,
    addedNodes: 0
  };
  const cargoWorkspace = document.uri.fsPath
    ? await loadCargoWorkspaceContext(document.uri.fsPath)
    : undefined;
  const descriptorCache = new Map<string, SymbolDescriptor[]>();
  const currentDocumentDescriptors = await getDocumentSymbolDescriptors(
    document,
    cargoWorkspace
  );
  descriptorCache.set(document.uri.toString(), currentDocumentDescriptors);
  const localGraphSymbols = baseGraph.nodes.filter(
    (node) => !node.isExternal && node.filePath === baseGraph.filePath
  );

  for (const graphSymbol of localGraphSymbols) {
    const matchingDescriptor = matchDescriptorToGraphNode(
      graphSymbol,
      currentDocumentDescriptors
    );

    if (!matchingDescriptor) {
      continue;
    }

    const position = new vscode.Position(
      Math.max(matchingDescriptor.selectionLine - 1, 0),
      matchingDescriptor.selectionCharacter
    );
    const lspSnapshot = await collectRustLspSnapshot(document, position);

    if (!lspSnapshot) {
      continue;
    }

    lspSummary.callHierarchyEdges += await mergeCallHierarchyEdges(
      graphState,
      graphSymbol,
      lspSnapshot,
      cargoWorkspace,
      descriptorCache
    );
    lspSummary.referenceEdges += await mergeReferenceEdges(
      graphState,
      graphSymbol,
      lspSnapshot,
      cargoWorkspace,
      descriptorCache
    );
  }

  lspSummary.definitionEdges += await mergeDefinitionEdges(
    graphState,
    document,
    syntax,
    cargoWorkspace,
    descriptorCache
  );
  lspSummary.addedNodes = graphState.graph.nodes.length - baseGraph.nodes.length;

  return {
    graph: graphState.graph,
    cargoWorkspace,
    lspSummary
  };
}

function createMutableGraphState(baseGraph: RepositoryGraph): MutableGraphState {
  const clonedNodes = baseGraph.nodes.map((node) => ({
    ...node,
    span: { ...node.span }
  }));
  const clonedEdges = baseGraph.edges.map((edge) => ({ ...edge }));

  return {
    graph: {
      ...baseGraph,
      nodes: clonedNodes,
      edges: clonedEdges
    },
    nodesById: new Map(clonedNodes.map((node) => [node.id, node])),
    nodeKeyToId: new Map(
      clonedNodes.map((node) => [createNodeKey(node.filePath, node.name, node.kind, node.span.startLine), node.id])
    ),
    edgeKeys: new Set(
      clonedEdges.map((edge) => createEdgeKey(edge.from, edge.to, edge.kind))
    )
  };
}

async function mergeCallHierarchyEdges(
  state: MutableGraphState,
  graphSymbol: SymbolNode,
  lspSnapshot: RustLspSnapshot,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>
): Promise<number> {
  let edgeCount = 0;

  for (const outgoingCall of lspSnapshot.outgoingCalls) {
    const targetNode = await ensureNodeFromCallHierarchyItem(
      state,
      outgoingCall.to,
      cargoWorkspace,
      descriptorCache
    );

    edgeCount += addEdgeIfMissing(state, {
      from: graphSymbol.id,
      to: targetNode.id,
      kind: "calls"
    });
    edgeCount += addEdgeIfMissing(state, {
      from: graphSymbol.id,
      to: targetNode.id,
      kind: "called_by"
    });
  }

  for (const incomingCall of lspSnapshot.incomingCalls) {
    const callerNode = await ensureNodeFromCallHierarchyItem(
      state,
      incomingCall.from,
      cargoWorkspace,
      descriptorCache
    );

    edgeCount += addEdgeIfMissing(state, {
      from: callerNode.id,
      to: graphSymbol.id,
      kind: "calls"
    });
    edgeCount += addEdgeIfMissing(state, {
      from: callerNode.id,
      to: graphSymbol.id,
      kind: "called_by"
    });
  }

  return edgeCount;
}

async function mergeReferenceEdges(
  state: MutableGraphState,
  graphSymbol: SymbolNode,
  lspSnapshot: RustLspSnapshot,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>
): Promise<number> {
  let edgeCount = 0;

  for (const reference of lspSnapshot.references) {
    if (isDeclarationLikeReference(reference, graphSymbol)) {
      continue;
    }

    const referrerNode = await ensureNodeFromLocation(
      state,
      reference.uri,
      reference.range.start,
      cargoWorkspace,
      descriptorCache
    );

    if (!referrerNode || referrerNode.id === graphSymbol.id) {
      continue;
    }

    edgeCount += addEdgeIfMissing(state, {
      from: referrerNode.id,
      to: graphSymbol.id,
      kind: "references"
    });
  }

  return edgeCount;
}

async function mergeDefinitionEdges(
  state: MutableGraphState,
  document: vscode.TextDocument,
  syntax: RustSyntaxParseResult,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>
): Promise<number> {
  let edgeCount = 0;

  for (const callBinding of syntax.callBindings) {
    const ownerNode = state.nodesById.get(callBinding.ownerSymbolId);

    if (!ownerNode) {
      continue;
    }

    const definitions = await vscode.commands.executeCommand<
      Array<vscode.Location | vscode.LocationLink>
    >(
      "vscode.executeDefinitionProvider",
      document.uri,
      new vscode.Position(
        Math.max(callBinding.sourcePosition.line - 1, 0),
        callBinding.sourcePosition.character
      )
    );

    for (const definition of definitions ?? []) {
      const targetNode = await ensureNodeFromDefinition(
        state,
        definition,
        cargoWorkspace,
        descriptorCache,
        callBinding.targetName,
        callBinding.targetKindHint
      );

      if (!targetNode) {
        continue;
      }

      edgeCount += addEdgeIfMissing(state, {
        from: ownerNode.id,
        to: targetNode.id,
        kind: "calls"
      });
      edgeCount += addEdgeIfMissing(state, {
        from: ownerNode.id,
        to: targetNode.id,
        kind: "called_by"
      });
    }
  }

  return edgeCount;
}

async function ensureNodeFromDefinition(
  state: MutableGraphState,
  definition: vscode.Location | vscode.LocationLink,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>,
  fallbackName: string,
  fallbackKind: SymbolKind
): Promise<SymbolNode | undefined> {
  if ("targetUri" in definition) {
    return ensureNodeFromLocation(
      state,
      definition.targetUri,
      definition.targetSelectionRange?.start ?? definition.targetRange.start,
      cargoWorkspace,
      descriptorCache,
      fallbackName,
      fallbackKind
    );
  }

  return ensureNodeFromLocation(
    state,
    definition.uri,
    definition.range.start,
    cargoWorkspace,
    descriptorCache,
    fallbackName,
    fallbackKind
  );
}

async function ensureNodeFromCallHierarchyItem(
  state: MutableGraphState,
  item: vscode.CallHierarchyItem,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>
): Promise<SymbolNode> {
  const resolvedNode = await ensureNodeFromLocation(
    state,
    item.uri,
    item.selectionRange.start,
    cargoWorkspace,
    descriptorCache,
    item.name,
    mapVscodeSymbolKind(item.kind)
  );

  if (resolvedNode) {
    return resolvedNode;
  }

  return ensureExternalNode(state, {
    name: item.name,
    kind: mapVscodeSymbolKind(item.kind),
    filePath: item.uri.fsPath || item.uri.path,
    modulePath: inferRustModulePath(item.uri.fsPath || item.uri.path, cargoWorkspace),
    span: {
      startLine: item.range.start.line + 1,
      endLine: item.range.end.line + 1
    }
  });
}

async function ensureNodeFromLocation(
  state: MutableGraphState,
  uri: vscode.Uri,
  position: vscode.Position,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>,
  fallbackName?: string,
  fallbackKind?: SymbolKind
): Promise<SymbolNode | undefined> {
  const filePath = uri.fsPath || uri.path;
  const existingLocalNode = findExistingNodeAtLocation(state.graph, filePath, position.line + 1);

  if (existingLocalNode) {
    return existingLocalNode;
  }

  const descriptors = await getDocumentSymbolDescriptorsForUri(
    uri,
    cargoWorkspace,
    descriptorCache
  );
  const containingDescriptor = descriptors.find(
    (descriptor) =>
      descriptor.span.startLine <= position.line + 1 &&
      descriptor.span.endLine >= position.line + 1
  );

  if (containingDescriptor) {
    return ensureNodeFromDescriptor(state, containingDescriptor);
  }

  if (!fallbackName || !fallbackKind) {
    return undefined;
  }

  return ensureExternalNode(state, {
    name: fallbackName,
    kind: fallbackKind,
    filePath,
    modulePath: inferRustModulePath(filePath, cargoWorkspace),
    span: {
      startLine: position.line + 1,
      endLine: position.line + 1
    }
  });
}

async function getDocumentSymbolDescriptorsForUri(
  uri: vscode.Uri,
  cargoWorkspace: CargoWorkspaceContext | undefined,
  descriptorCache: Map<string, SymbolDescriptor[]>
): Promise<SymbolDescriptor[]> {
  const cacheKey = uri.toString();
  const cached = descriptorCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const descriptors = await getDocumentSymbolDescriptors(document, cargoWorkspace);
  descriptorCache.set(cacheKey, descriptors);
  return descriptors;
}

async function getDocumentSymbolDescriptors(
  document: vscode.TextDocument,
  cargoWorkspace: CargoWorkspaceContext | undefined
): Promise<SymbolDescriptor[]> {
  const rawSymbols = await vscode.commands.executeCommand<
    Array<vscode.DocumentSymbol | vscode.SymbolInformation>
  >("vscode.executeDocumentSymbolProvider", document.uri);

  return flattenDocumentSymbols(
    rawSymbols ?? [],
    document.uri.fsPath || document.uri.path,
    cargoWorkspace
  );
}

function flattenDocumentSymbols(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  filePath: string,
  cargoWorkspace: CargoWorkspaceContext | undefined
): SymbolDescriptor[] {
  const modulePath = inferRustModulePath(filePath, cargoWorkspace);
  const descriptors: SymbolDescriptor[] = [];

  for (const symbol of symbols) {
    if ("location" in symbol) {
      descriptors.push({
        name: symbol.name,
        kind: mapVscodeSymbolKind(symbol.kind),
        filePath: symbol.location.uri.fsPath || symbol.location.uri.path,
        modulePath,
        span: {
          startLine: symbol.location.range.start.line + 1,
          endLine: symbol.location.range.end.line + 1
        },
        selectionLine: symbol.location.range.start.line + 1,
        selectionCharacter: symbol.location.range.start.character
      });
      continue;
    }

    descriptors.push(
      ...flattenNestedDocumentSymbol(
        symbol,
        filePath,
        modulePath,
        undefined
      )
    );
  }

  return descriptors;
}

function flattenNestedDocumentSymbol(
  symbol: vscode.DocumentSymbol,
  filePath: string,
  modulePath: string,
  parent?: SymbolDescriptor
): SymbolDescriptor[] {
  const kind = inferRustSymbolKindFromDocumentSymbol(symbol, parent);
  const current: SymbolDescriptor = {
    name: symbol.name,
    kind,
    filePath,
    modulePath: kind === "module" ? `${modulePath}::${symbol.name}` : modulePath,
    span: {
      startLine: symbol.range.start.line + 1,
      endLine: symbol.range.end.line + 1
    },
    selectionLine: symbol.selectionRange.start.line + 1,
    selectionCharacter: symbol.selectionRange.start.character
  };

  return [
    current,
    ...symbol.children.flatMap((child) =>
      flattenNestedDocumentSymbol(
        child,
        filePath,
        current.kind === "module" ? current.modulePath : modulePath,
        current
      )
    )
  ];
}

function inferRustSymbolKindFromDocumentSymbol(
  symbol: vscode.DocumentSymbol,
  parent?: SymbolDescriptor
): SymbolKind {
  if (
    symbol.kind === vscode.SymbolKind.Method ||
    symbol.kind === vscode.SymbolKind.Constructor
  ) {
    return "method";
  }

  if (symbol.kind === vscode.SymbolKind.Function) {
    return parent?.kind === "impl" || parent?.kind === "trait"
      ? "method"
      : "function";
  }

  return mapVscodeSymbolKind(symbol.kind);
}

function matchDescriptorToGraphNode(
  node: SymbolNode,
  descriptors: SymbolDescriptor[]
): SymbolDescriptor | undefined {
  return descriptors.find(
    (descriptor) =>
      descriptor.name === node.name &&
      descriptor.kind === node.kind &&
      descriptor.filePath === node.filePath &&
      descriptor.span.startLine === node.span.startLine
  );
}

function ensureNodeFromDescriptor(
  state: MutableGraphState,
  descriptor: SymbolDescriptor
): SymbolNode {
  const nodeKey = createNodeKey(
    descriptor.filePath,
    descriptor.name,
    descriptor.kind,
    descriptor.span.startLine
  );
  const existingId = state.nodeKeyToId.get(nodeKey);

  if (existingId) {
    const existingNode = state.nodesById.get(existingId);

    if (existingNode) {
      return existingNode;
    }
  }

  const node: SymbolNode = {
    id: `rust:lsp:${descriptor.filePath}:${descriptor.modulePath}:${descriptor.kind}:${descriptor.name}:${descriptor.span.startLine}`,
    name: descriptor.name,
    kind: descriptor.kind,
    filePath: descriptor.filePath,
    modulePath: descriptor.modulePath,
    span: descriptor.span,
    language: "rust"
  };

  state.graph.nodes.push(node);
  state.nodesById.set(node.id, node);
  state.nodeKeyToId.set(nodeKey, node.id);
  return node;
}

function ensureExternalNode(
  state: MutableGraphState,
  input: {
    name: string;
    kind: SymbolKind;
    filePath: string;
    modulePath: string;
    span: {
      startLine: number;
      endLine: number;
    };
  }
): SymbolNode {
  const nodeKey = createNodeKey(
    input.filePath,
    input.name,
    input.kind,
    input.span.startLine
  );
  const existingId = state.nodeKeyToId.get(nodeKey);

  if (existingId) {
    const existingNode = state.nodesById.get(existingId);

    if (existingNode) {
      return existingNode;
    }
  }

  const node: SymbolNode = {
    id: `rust:lsp-external:${input.filePath}:${input.modulePath}:${input.kind}:${input.name}:${input.span.startLine}`,
    name: input.name,
    kind: input.kind,
    filePath: input.filePath,
    modulePath: input.modulePath,
    span: input.span,
    isExternal: true,
    language: "rust"
  };

  state.graph.nodes.push(node);
  state.nodesById.set(node.id, node);
  state.nodeKeyToId.set(nodeKey, node.id);
  return node;
}

function findExistingNodeAtLocation(
  graph: RepositoryGraph,
  filePath: string,
  lineNumber: number
): SymbolNode | undefined {
  return graph.nodes
    .filter(
      (node) =>
        node.filePath === filePath &&
        node.span.startLine <= lineNumber &&
        node.span.endLine >= lineNumber
    )
    .sort((left, right) => {
      const leftSize = left.span.endLine - left.span.startLine;
      const rightSize = right.span.endLine - right.span.startLine;

      return leftSize - rightSize;
    })[0];
}

function isDeclarationLikeReference(
  reference: vscode.Location,
  symbol: SymbolNode
): boolean {
  return (
    normalizeFilePath(reference.uri.fsPath || reference.uri.path) ===
      normalizeFilePath(symbol.filePath) &&
    reference.range.start.line + 1 === symbol.span.startLine
  );
}

function addEdgeIfMissing(state: MutableGraphState, edge: Edge): number {
  const edgeKey = createEdgeKey(edge.from, edge.to, edge.kind);

  if (state.edgeKeys.has(edgeKey)) {
    return 0;
  }

  state.edgeKeys.add(edgeKey);
  state.graph.edges.push(edge);
  return 1;
}

function createEdgeKey(from: string, to: string, kind: Edge["kind"]): string {
  return `${from}|${to}|${kind}`;
}

function createNodeKey(
  filePath: string,
  name: string,
  kind: SymbolKind,
  startLine: number
): string {
  return `${normalizeFilePath(filePath)}|${name}|${kind}|${startLine}`;
}

function mapVscodeSymbolKind(kind: vscode.SymbolKind): SymbolKind {
  switch (kind) {
    case vscode.SymbolKind.Struct:
      return "struct";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.Interface:
      return "trait";
    case vscode.SymbolKind.Class:
      return "impl";
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return "method";
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
      return "module";
    case vscode.SymbolKind.Function:
    default:
      return "function";
  }
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
