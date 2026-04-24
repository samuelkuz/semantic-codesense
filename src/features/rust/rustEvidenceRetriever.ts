import path from "node:path";

import { EvidenceRepository } from "../../evidence/evidenceRepository";
import {
  BudgetedEvidenceRetriever,
  type EvidenceRetrievalBackend,
  type RetrievedArtifactCandidate,
  type RetrievalExecutionContext
} from "../../retrieval/evidenceRetriever";
import type { EvidenceArtifact, EvidenceMetadata } from "../../types/evidence";
import type { RepositoryGraph, SymbolKind, SymbolNode, SymbolRef } from "../../types/graph";
import type { EvidenceRetriever, RetrievalAction } from "../../types/retrieval";
import { inferRustModulePath, loadCargoWorkspaceContext } from "./rustCargoMetadata";
import { buildRustFileGraph } from "./rustGraphBuilder";
import { findBestLocalSymbolNodeForLookup } from "./rustLocalSymbolResolver";
import { parseRustSyntaxFile } from "./rustTreeSitterParser";

type VscodeModule = typeof import("vscode");
type VsCodeUri = import("vscode").Uri;
type VsCodePosition = import("vscode").Position;
type VsCodeRange = import("vscode").Range;
type VsCodeDocument = import("vscode").TextDocument;
type VsCodeDocumentSymbol = import("vscode").DocumentSymbol;
type VsCodeSymbolInformation = import("vscode").SymbolInformation;

interface ResolvedRustSymbol {
  id?: string;
  name: string;
  kind?: SymbolKind | "field";
  filePath: string;
  modulePath?: string;
  startLine?: number;
  endLine?: number;
  resolvedBy: "evidence" | "workspace_symbol" | "document_symbol" | "tree_sitter";
}

const COMMON_TYPE_NAMES = new Set([
  "Option",
  "Result",
  "String",
  "Vec",
  "Self",
  "str",
  "bool",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "f32",
  "f64"
]);
const COMPACT_SNIPPET_MAX_LINES = 80;

export class RustEvidenceRetriever extends BudgetedEvidenceRetriever {
  constructor(
    repository: EvidenceRepository,
    backend: EvidenceRetrievalBackend = createRustRetrievalBackend()
  ) {
    super(repository, backend);
  }
}

export function createRustEvidenceRetriever(
  repository: EvidenceRepository
): EvidenceRetriever {
  return new RustEvidenceRetriever(repository);
}

export function createRustRetrievalBackend(): EvidenceRetrievalBackend {
  return {
    async retrieve(
      context: RetrievalExecutionContext
    ): Promise<RetrievedArtifactCandidate[]> {
      switch (context.action.type) {
        case "fetch_helper_definition":
          return fetchDefinitionArtifacts(
            context,
            ["function", "method"],
            "helper_definition"
          );
        case "fetch_type_definition":
          return fetchDefinitionArtifacts(
            context,
            ["struct", "enum", "trait"],
            "type_definition"
          );
        case "fetch_call_sites":
          return fetchCallSiteArtifacts(context);
        case "fetch_callers":
          return fetchCallerArtifacts(context);
        case "fetch_trait_impls":
          return fetchTraitImplArtifacts(context);
        case "fetch_field_usages":
          return fetchFieldUsageArtifacts(context);
        default:
          return [];
      }
    }
  };
}

async function fetchDefinitionArtifacts(
  context: RetrievalExecutionContext,
  preferredKinds: Array<SymbolKind>,
  artifactKind: "helper_definition" | "type_definition"
): Promise<RetrievedArtifactCandidate[]> {
  const target = await resolveNamedSymbol(
    context.ref,
    context.currentEvidence,
    context.action.targetName,
    preferredKinds
  );

  if (!target) {
    return [];
  }

  const document = await openRustDocument(target.filePath);
  const sourceText = document?.getText();
  const matchedNode = sourceText
    ? findBestLocalSymbolNode(target, sourceText)
    : undefined;
  const snippet = document
    ? getSnippetForResolvedSymbolFromDocument(target, document, matchedNode)
    : undefined;

  if (!snippet) {
    return [];
  }

  const artifacts: RetrievedArtifactCandidate[] = [{
    kind: artifactKind,
    title: `${target.kind ?? "symbol"} \`${target.name}\` in \`${target.filePath}\``,
    content: snippet,
    retrievedBy:
      target.resolvedBy === "tree_sitter" ? "tree_sitter" : "hybrid",
    metadata: createResolvedSymbolMetadata(target, matchedNode)
  }];

  if (artifactKind === "helper_definition" && document && sourceText && matchedNode) {
    artifacts.push(
      ...await collectSupplementalHelperArtifacts(
        context,
        target,
        matchedNode,
        document,
        sourceText,
        context.maxArtifacts - artifacts.length
      )
    );
  }

  return artifacts.slice(0, context.maxArtifacts);
}

async function fetchCallSiteArtifacts(
  context: RetrievalExecutionContext
): Promise<RetrievedArtifactCandidate[]> {
  const rootSymbol = await resolveRootSymbol(context.ref, context.currentEvidence);

  if (!rootSymbol) {
    return [];
  }

  const { document, position } = await getSymbolDocumentAndPosition(rootSymbol);

  if (!document || !position) {
    return [];
  }

  const vscode = getVscode();
  const references = await vscode.commands.executeCommand<import("vscode").Location[]>(
    "vscode.executeReferenceProvider",
    document.uri,
    position
  );
  const usageArtifacts = await buildUsageArtifactsFromReferences(
    references ?? [],
    rootSymbol,
    "call_site",
    context.action,
    context.maxArtifacts
  );

  return usageArtifacts;
}

async function fetchCallerArtifacts(
  context: RetrievalExecutionContext
): Promise<RetrievedArtifactCandidate[]> {
  const rootSymbol = await resolveRootSymbol(context.ref, context.currentEvidence);

  if (!rootSymbol) {
    return [];
  }

  const { document, position } = await getSymbolDocumentAndPosition(rootSymbol);

  if (!document || !position) {
    return [];
  }

  const vscode = getVscode();
  const callHierarchyItems = await vscode.commands.executeCommand<
    import("vscode").CallHierarchyItem[]
  >("vscode.prepareCallHierarchy", document.uri, position);
  const rootItem = callHierarchyItems?.[0];

  if (rootItem) {
    const incomingCalls = await vscode.commands.executeCommand<
      import("vscode").CallHierarchyIncomingCall[]
    >("vscode.provideIncomingCalls", rootItem);
    const seen = new Set<string>();
    const artifacts: RetrievedArtifactCandidate[] = [];

    for (const incomingCall of incomingCalls ?? []) {
      const callerDocument = await vscode.workspace.openTextDocument(incomingCall.from.uri);
      const range = incomingCall.from.range;
      const key = `${incomingCall.from.uri.toString()}:${range.start.line}:${incomingCall.from.name}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      artifacts.push({
        kind: "caller",
        title: `${incomingCall.from.name} in \`${incomingCall.from.uri.fsPath || incomingCall.from.uri.path}\``,
        content: extractRangeSnippet(callerDocument, range, 60),
        retrievedBy: "rust_analyzer",
        metadata: {
          filePath: incomingCall.from.uri.fsPath || incomingCall.from.uri.path,
          startLine: range.start.line + 1,
          endLine: range.end.line + 1,
          symbolName: incomingCall.from.name,
          renderAsCode: true
        }
      });

      if (artifacts.length >= context.maxArtifacts) {
        break;
      }
    }

    if (artifacts.length > 0) {
      return artifacts;
    }
  }

  const references = await vscode.commands.executeCommand<import("vscode").Location[]>(
    "vscode.executeReferenceProvider",
    document.uri,
    position
  );

  return buildUsageArtifactsFromReferences(
    references ?? [],
    rootSymbol,
    "caller",
    context.action,
    context.maxArtifacts
  );
}

async function fetchTraitImplArtifacts(
  context: RetrievalExecutionContext
): Promise<RetrievedArtifactCandidate[]> {
  const target = await resolveNamedSymbol(
    context.ref,
    context.currentEvidence,
    context.action.targetName,
    ["struct", "enum", "trait"]
  );

  if (!target) {
    return [];
  }

  const document = await openRustDocument(target.filePath);

  if (!document) {
    return [];
  }

  const syntax = parseRustSyntaxFile({
    filePath: target.filePath,
    sourceText: document.getText()
  });
  const implArtifacts: RetrievedArtifactCandidate[] = [];

  for (const binding of syntax.implBindings) {
    if (
      binding.targetTypeName !== target.name &&
      binding.traitName !== target.name
    ) {
      continue;
    }

    const implSymbol = syntax.symbols.find(
      (symbol) => symbol.id === binding.implSymbolId
    );

    if (!implSymbol) {
      continue;
    }

    const snippet = extractNodeSnippet(document, implSymbol, true);

    if (!snippet) {
      continue;
    }

    implArtifacts.push({
      kind: "trait_impl",
      title: `impl for \`${target.name}\` in \`${target.filePath}\``,
      content: snippet,
      retrievedBy: "tree_sitter",
      groupKey: target.name,
      metadata: createNodeMetadata(implSymbol, {
        filePath: target.filePath,
        symbolName: target.name
      })
    });
  }

  return implArtifacts.slice(0, context.maxArtifacts);
}

async function fetchFieldUsageArtifacts(
  context: RetrievalExecutionContext
): Promise<RetrievedArtifactCandidate[]> {
  const fieldName = context.action.targetName?.trim();

  if (!fieldName) {
    return [];
  }

  const declaration = await resolveFieldDeclaration(
    context.ref,
    context.currentEvidence,
    fieldName
  );

  if (declaration) {
    const artifacts = await fetchFieldReferencesFromDeclaration(
      declaration,
      fieldName,
      context.maxArtifacts
    );

    if (artifacts.length > 0) {
      return artifacts;
    }
  }

  return fetchFieldUsageFallback(
    context.ref,
    context.currentEvidence,
    fieldName,
    context.maxArtifacts
  );
}

async function resolveRootSymbol(
  ref: SymbolRef,
  currentEvidence: EvidenceArtifact[]
): Promise<ResolvedRustSymbol | undefined> {
  const targetDefinition = currentEvidence.find(
    (artifact) => artifact.kind === "target_definition"
  );

  const filePath = typeof targetDefinition?.metadata?.filePath === "string"
    ? targetDefinition.metadata.filePath
    : ref.filePath;

  if (!filePath) {
    return undefined;
  }

  return {
    id: ref.id,
    name: ref.name,
    kind: ref.kind,
    filePath,
    modulePath:
      typeof targetDefinition?.metadata?.modulePath === "string"
        ? targetDefinition.metadata.modulePath
        : ref.modulePath,
    startLine:
      typeof targetDefinition?.metadata?.startLine === "number"
        ? targetDefinition.metadata.startLine
        : undefined,
    endLine:
      typeof targetDefinition?.metadata?.endLine === "number"
        ? targetDefinition.metadata.endLine
        : undefined,
    resolvedBy: "evidence"
  };
}

async function resolveNamedSymbol(
  ref: SymbolRef,
  currentEvidence: EvidenceArtifact[],
  targetName: string | undefined,
  preferredKinds: Array<SymbolKind>
): Promise<ResolvedRustSymbol | undefined> {
  if (!targetName) {
    return undefined;
  }

  const normalizedTarget = targetName.trim().toLowerCase();
  const evidenceMatch = currentEvidence.find((artifact) => {
    const symbolName = artifact.metadata?.symbolName;

    return (
      typeof symbolName === "string" &&
      symbolName.trim().toLowerCase() === normalizedTarget
    );
  });

  if (evidenceMatch && typeof evidenceMatch.metadata?.filePath === "string") {
    return {
      id:
        typeof evidenceMatch.metadata?.nodeId === "string"
          ? evidenceMatch.metadata.nodeId
          : undefined,
      name: targetName,
      kind:
        typeof evidenceMatch.metadata?.symbolKind === "string"
          ? (evidenceMatch.metadata.symbolKind as SymbolKind)
          : undefined,
      filePath: evidenceMatch.metadata.filePath,
      modulePath:
        typeof evidenceMatch.metadata?.modulePath === "string"
          ? evidenceMatch.metadata.modulePath
          : undefined,
      startLine:
        typeof evidenceMatch.metadata?.startLine === "number"
          ? evidenceMatch.metadata.startLine
          : undefined,
      endLine:
        typeof evidenceMatch.metadata?.endLine === "number"
          ? evidenceMatch.metadata.endLine
          : undefined,
      resolvedBy: "evidence"
    };
  }

  const workspaceMatch = await resolveSymbolViaWorkspaceSymbols(
    ref,
    targetName,
    preferredKinds
  );

  if (workspaceMatch) {
    return workspaceMatch;
  }

  return resolveSymbolInFile(ref.filePath, targetName, preferredKinds);
}

async function resolveSymbolViaWorkspaceSymbols(
  ref: SymbolRef,
  targetName: string,
  preferredKinds: Array<SymbolKind>
): Promise<ResolvedRustSymbol | undefined> {
  const vscode = getVscode();
  const workspaceSymbols = await vscode.commands.executeCommand<
    import("vscode").SymbolInformation[]
  >("vscode.executeWorkspaceSymbolProvider", targetName);
  const cargoWorkspace = ref.filePath
    ? await loadCargoWorkspaceContext(ref.filePath)
    : undefined;
  const matchingSymbol = (workspaceSymbols ?? [])
    .filter((symbol) => symbol.name === targetName)
    .sort((left, right) => {
      const leftKindScore = preferredKinds.includes(mapWorkspaceSymbolKind(left.kind))
        ? 0
        : 1;
      const rightKindScore = preferredKinds.includes(mapWorkspaceSymbolKind(right.kind))
        ? 0
        : 1;

      if (leftKindScore !== rightKindScore) {
        return leftKindScore - rightKindScore;
      }

      const leftFile = left.location.uri.fsPath || left.location.uri.path;
      const rightFile = right.location.uri.fsPath || right.location.uri.path;
      const leftSameFile = ref.filePath && leftFile === ref.filePath ? 0 : 1;
      const rightSameFile = ref.filePath && rightFile === ref.filePath ? 0 : 1;

      return leftSameFile - rightSameFile;
    })[0];

  if (!matchingSymbol) {
    return undefined;
  }

  const filePath = matchingSymbol.location.uri.fsPath || matchingSymbol.location.uri.path;

  return {
    id: `rust:workspace-symbol:${matchingSymbol.location.uri.toString()}:${matchingSymbol.name}:${matchingSymbol.location.range.start.line + 1}`,
    name: matchingSymbol.name,
    kind: mapWorkspaceSymbolKind(matchingSymbol.kind),
    filePath,
    modulePath: inferRustModulePath(filePath, cargoWorkspace),
    startLine: matchingSymbol.location.range.start.line + 1,
    endLine: matchingSymbol.location.range.end.line + 1,
    resolvedBy: "workspace_symbol"
  };
}

async function resolveSymbolInFile(
  filePath: string | undefined,
  targetName: string,
  preferredKinds: Array<SymbolKind>
): Promise<ResolvedRustSymbol | undefined> {
  if (!filePath) {
    return undefined;
  }

  const document = await openRustDocument(filePath);

  if (!document) {
    return undefined;
  }

  const graph = buildRustFileGraph({
    filePath,
    sourceText: document.getText()
  });
  const match = graph.nodes.find(
    (node) =>
      node.name === targetName &&
      preferredKinds.includes(node.kind) &&
      !node.isExternal
  );

  if (!match) {
    return undefined;
  }

  return {
    id: match.id,
    name: match.name,
    kind: match.kind,
    filePath: match.filePath,
    modulePath: match.modulePath,
    startLine: match.span.startLine,
    endLine: match.span.endLine,
    resolvedBy: "tree_sitter"
  };
}

function getSnippetForResolvedSymbolFromDocument(
  symbol: ResolvedRustSymbol,
  document: VsCodeDocument,
  matchedNode?: SymbolNode
): string | undefined {
  if (matchedNode) {
    return extractNodeSnippet(document, matchedNode, true);
  }

  const fallbackLine = Math.max((symbol.startLine ?? 1) - 1, 0);
  const endLine = Math.min(fallbackLine + 20, document.lineCount - 1);
  const range = new (getVscode().Range)(
    fallbackLine,
    0,
    endLine,
    document.lineAt(endLine).text.length
  );

  return extractRangeSnippet(document, range, 20);
}

async function collectSupplementalHelperArtifacts(
  context: RetrievalExecutionContext,
  target: ResolvedRustSymbol,
  helperNode: SymbolNode,
  document: VsCodeDocument,
  sourceText: string,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  if (maxArtifacts <= 0) {
    return [];
  }

  const graph = buildRustFileGraph({
    filePath: target.filePath,
    sourceText
  });
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const parentNode = helperNode.parentSymbolId
    ? nodesById.get(helperNode.parentSymbolId)
    : undefined;
  const artifacts: RetrievedArtifactCandidate[] = [];

  if (parentNode?.kind === "trait") {
    artifacts.push(
      ...await collectTraitImplArtifactsForHelperMethod(
        context,
        parentNode.name,
        helperNode.name,
        maxArtifacts - artifacts.length
      )
    );
  }

  if (artifacts.length < maxArtifacts) {
    artifacts.push(
      ...await collectRelatedTypeArtifactsForHelper(
        context,
        graph,
        helperNode,
        document,
        maxArtifacts - artifacts.length
      )
    );
  }

  return dedupeArtifactCandidates(artifacts).slice(0, maxArtifacts);
}

async function collectTraitImplArtifactsForHelperMethod(
  context: RetrievalExecutionContext,
  traitName: string,
  methodName: string,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  if (maxArtifacts <= 0) {
    return [];
  }

  const artifacts: RetrievedArtifactCandidate[] = [];

  for (const filePath of collectCandidateFiles(context.ref, context.currentEvidence)) {
    const document = await openRustDocument(filePath);

    if (!document) {
      continue;
    }

    const graph = buildRustFileGraph({
      filePath,
      sourceText: document.getText()
    });
    const matchingImplNodes = findTraitImplNodesForMethod(
      graph,
      traitName,
      methodName
    );

    for (const implNode of matchingImplNodes) {
      const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));

      const snippet = extractNodeSnippet(document, implNode, true);

      if (!snippet) {
        continue;
      }

      const targetTypeName = graph.edges
        .filter((edge) => edge.from === implNode.id && edge.kind === "belongs_to")
        .map((edge) => nodesById.get(edge.to)?.name)
        .find((name): name is string => typeof name === "string" && name.length > 0);
      const title = targetTypeName
        ? `impl ${traitName} for ${targetTypeName}`
        : implNode.name;

      artifacts.push({
        kind: "trait_impl",
        title,
        content: snippet,
        retrievedBy: "tree_sitter",
        groupKey: traitName,
        metadata: createNodeMetadata(implNode, {
          relationship: "helper_trait_impl",
          symbolName: traitName,
          traitName,
          targetMethodName: methodName
        })
      });

      if (artifacts.length >= maxArtifacts) {
        return artifacts;
      }
    }
  }

  return artifacts;
}

async function collectRelatedTypeArtifactsForHelper(
  context: RetrievalExecutionContext,
  graph: RepositoryGraph,
  helperNode: SymbolNode,
  document: VsCodeDocument,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  if (maxArtifacts <= 0) {
    return [];
  }

  const uniqueTypeNames = getHelperRelatedTypeNames(graph, helperNode);
  const artifacts: RetrievedArtifactCandidate[] = [];

  for (const typeName of uniqueTypeNames) {
    const resolvedType = await resolveNamedSymbol(
      context.ref,
      context.currentEvidence,
      typeName,
      ["struct", "enum", "trait"]
    );

    if (!resolvedType) {
      continue;
    }

    const typeDocument =
      normalizeFilePath(resolvedType.filePath) ===
      normalizeFilePath(document.uri.fsPath || document.uri.path)
        ? document
        : await openRustDocument(resolvedType.filePath);

    if (!typeDocument) {
      continue;
    }

    const sourceText = typeDocument.getText();
    const matchedNode = findBestLocalSymbolNode(resolvedType, sourceText);
    const snippet = getSnippetForResolvedSymbolFromDocument(
      resolvedType,
      typeDocument,
      matchedNode
    );

    if (!snippet) {
      continue;
    }

    artifacts.push({
      kind: "type_definition",
      title: `${resolvedType.kind ?? "type"} \`${resolvedType.name}\` in \`${resolvedType.filePath}\``,
      content: snippet,
      retrievedBy:
        resolvedType.resolvedBy === "tree_sitter" ? "tree_sitter" : "hybrid",
      groupKey: resolvedType.name,
      metadata: {
        ...createResolvedSymbolMetadata(resolvedType, matchedNode),
        relationship: "helper_related_type",
        sourceHelperName: helperNode.name
      }
    });

    if (artifacts.length >= maxArtifacts) {
      break;
    }
  }

  return artifacts;
}

export function findTraitImplNodesForMethod(
  graph: RepositoryGraph,
  traitName: string,
  methodName: string
): SymbolNode[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));

  return graph.nodes.filter((implNode) => {
    if (implNode.kind !== "impl") {
      return false;
    }

    const implementedTraitEdge = graph.edges.find(
      (edge) =>
        edge.from === implNode.id &&
        edge.kind === "implements" &&
        nodesById.get(edge.to)?.name === traitName
    );

    if (!implementedTraitEdge) {
      return false;
    }

    return graph.nodes.some(
      (node) =>
        node.parentSymbolId === implNode.id &&
        node.kind === "method" &&
        node.name === methodName
    );
  });
}

export function getHelperRelatedTypeNames(
  graph: RepositoryGraph,
  helperNode: SymbolNode
): string[] {
  const relatedTypeNames = graph.edges
    .filter((edge): boolean => edge.from === helperNode.id && edge.kind === "uses_type")
    .map((edge): SymbolNode | undefined => graph.nodes.find((node) => node.id === edge.to))
    .filter((node): node is SymbolNode => node !== undefined)
    .filter(
      (node): boolean =>
        (node.kind === "struct" || node.kind === "enum" || node.kind === "trait") &&
        !COMMON_TYPE_NAMES.has(node.name)
    )
    .map((node): string => node.name);

  return [...new Set(relatedTypeNames)];
}

function dedupeArtifactCandidates(
  artifacts: RetrievedArtifactCandidate[]
): RetrievedArtifactCandidate[] {
  const seen = new Set<string>();

  return artifacts.filter((artifact) => {
    const key = [
      artifact.kind,
      String(artifact.metadata?.filePath ?? ""),
      String(artifact.metadata?.startLine ?? ""),
      String(artifact.metadata?.symbolName ?? ""),
      artifact.title
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function findBestLocalSymbolNode(
  symbol: ResolvedRustSymbol,
  sourceText: string
): SymbolNode | undefined {
  return findBestLocalSymbolNodeForLookup(symbol, sourceText);
}

function createResolvedSymbolMetadata(
  symbol: ResolvedRustSymbol,
  matchedNode?: SymbolNode
): EvidenceMetadata {
  return {
    nodeId: symbol.id ?? `${symbol.filePath}:${symbol.name}:${symbol.startLine ?? 0}`,
    filePath: symbol.filePath,
    modulePath: symbol.modulePath ?? path.basename(symbol.filePath, path.extname(symbol.filePath)),
    symbolKind: symbol.kind ?? "function",
    symbolName: symbol.name,
    startLine: matchedNode?.span.startLine ?? symbol.startLine ?? 1,
    endLine: matchedNode?.span.endLine ?? symbol.endLine ?? symbol.startLine ?? 1
  };
}

async function getSymbolDocumentAndPosition(
  symbol: ResolvedRustSymbol
): Promise<{
  document: VsCodeDocument | undefined;
  position: VsCodePosition | undefined;
}> {
  const document = await openRustDocument(symbol.filePath);

  if (!document) {
    return {
      document: undefined,
      position: undefined
    };
  }

  const lineIndex = Math.max((symbol.startLine ?? 1) - 1, 0);
  const lineText = document.lineAt(Math.min(lineIndex, document.lineCount - 1)).text;
  const character = Math.max(lineText.indexOf(symbol.name), 0);

  return {
    document,
    position: new (getVscode().Position)(lineIndex, character)
  };
}

async function buildUsageArtifactsFromReferences(
  references: import("vscode").Location[],
  rootSymbol: ResolvedRustSymbol,
  artifactKind: "call_site" | "caller" | "field_access",
  action: RetrievalAction,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  const artifacts: RetrievedArtifactCandidate[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    if (
      normalizeFilePath(reference.uri.fsPath || reference.uri.path) ===
        normalizeFilePath(rootSymbol.filePath) &&
      rootSymbol.startLine !== undefined &&
      reference.range.start.line + 1 === rootSymbol.startLine
    ) {
      continue;
    }

    const enclosingSymbol = await getEnclosingUsageSymbol(
      reference.uri,
      reference.range.start
    );
    const referenceDocument = await getVscode().workspace.openTextDocument(reference.uri);
    const enclosingRange = getSymbolRange(enclosingSymbol);
    const snippet = enclosingRange
      ? extractRangeSnippet(referenceDocument, enclosingRange, 60)
      : referenceDocument.lineAt(reference.range.start.line).text.trim();
    const filePath = reference.uri.fsPath || reference.uri.path;
    const title = enclosingSymbol?.name ?? path.basename(filePath);
    const key = `${filePath}:${enclosingRange?.start.line ?? reference.range.start.line}:${title}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    artifacts.push({
      kind: artifactKind,
      title,
      content: snippet,
      retrievedBy: "hybrid",
      metadata: {
        filePath,
        startLine: (enclosingRange?.start.line ?? reference.range.start.line) + 1,
        endLine: (enclosingRange?.end.line ?? reference.range.end.line) + 1,
        callLine: reference.range.start.line + 1,
        symbolName: title,
        retrievalTargetName: action.targetName ?? rootSymbol.name
      }
    });

    if (artifacts.length >= maxArtifacts) {
      break;
    }
  }

  return artifacts;
}

async function resolveFieldDeclaration(
  ref: SymbolRef,
  currentEvidence: EvidenceArtifact[],
  fieldName: string
): Promise<ResolvedRustSymbol | undefined> {
  const candidateFiles = collectCandidateFiles(ref, currentEvidence);

  for (const filePath of candidateFiles) {
    const document = await openRustDocument(filePath);

    if (!document) {
      continue;
    }

    const fieldSymbol = await findFieldSymbol(document, fieldName);

    if (!fieldSymbol) {
      continue;
    }

    return {
      id: `${filePath}:${fieldName}:${fieldSymbol.range.start.line + 1}`,
      name: fieldName,
      kind: "field",
      filePath,
      startLine: fieldSymbol.range.start.line + 1,
      endLine: fieldSymbol.range.end.line + 1,
      resolvedBy: "document_symbol"
    };
  }

  return undefined;
}

async function fetchFieldReferencesFromDeclaration(
  declaration: ResolvedRustSymbol,
  fieldName: string,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  const { document, position } = await getSymbolDocumentAndPosition(declaration);

  if (!document || !position) {
    return [];
  }

  const vscode = getVscode();
  const references = await vscode.commands.executeCommand<import("vscode").Location[]>(
    "vscode.executeReferenceProvider",
    document.uri,
    position
  );
  const groupedArtifacts = await buildUsageArtifactsFromReferences(
    references ?? [],
    declaration,
    "field_access",
    {
      type: "fetch_field_usages",
      targetName: fieldName,
      priority: "medium"
    },
    maxArtifacts
  );

  return groupedArtifacts.map((artifact, index) => ({
    ...artifact,
    title: `field \`${fieldName}\` usage ${index + 1}`,
    groupKey: fieldName
  }));
}

async function fetchFieldUsageFallback(
  ref: SymbolRef,
  currentEvidence: EvidenceArtifact[],
  fieldName: string,
  maxArtifacts: number
): Promise<RetrievedArtifactCandidate[]> {
  const candidateFiles = collectCandidateFiles(ref, currentEvidence);
  const artifacts: RetrievedArtifactCandidate[] = [];

  for (const filePath of candidateFiles) {
    const document = await openRustDocument(filePath);

    if (!document) {
      continue;
    }

    const graph = buildRustFileGraph({
      filePath,
      sourceText: document.getText()
    });

    for (const node of graph.nodes) {
      if (
        node.isExternal ||
        node.kind === "module" ||
        node.signature?.includes(fieldName) === false &&
          !extractNodeSnippet(document, node, true)?.includes(fieldName)
      ) {
        continue;
      }

      const snippet = extractNodeSnippet(document, node, true);

      if (!snippet || !snippet.includes(fieldName)) {
        continue;
      }

      artifacts.push({
        kind: "field_access",
        title: `field \`${fieldName}\` usage in \`${node.name}\``,
        content: snippet,
        retrievedBy: "tree_sitter",
        groupKey: fieldName,
        metadata: createNodeMetadata(node)
      });

      if (artifacts.length >= maxArtifacts) {
        return artifacts;
      }
    }
  }

  return artifacts;
}

function collectCandidateFiles(
  ref: SymbolRef,
  currentEvidence: EvidenceArtifact[]
): string[] {
  const filePaths = new Set<string>();

  if (ref.filePath) {
    filePaths.add(ref.filePath);
  }

  for (const artifact of currentEvidence) {
    const filePath = artifact.metadata?.filePath;

    if (typeof filePath === "string" && filePath.length > 0) {
      filePaths.add(filePath);
    }
  }

  return [...filePaths];
}

async function findFieldSymbol(
  document: VsCodeDocument,
  fieldName: string
): Promise<VsCodeDocumentSymbol | undefined> {
  const vscode = getVscode();
  const symbols = await vscode.commands.executeCommand<
    Array<import("vscode").DocumentSymbol | import("vscode").SymbolInformation>
  >("vscode.executeDocumentSymbolProvider", document.uri);

  return findFieldSymbolInTree(symbols ?? [], fieldName);
}

function findFieldSymbolInTree(
  symbols: Array<VsCodeDocumentSymbol | VsCodeSymbolInformation>,
  fieldName: string
): VsCodeDocumentSymbol | undefined {
  for (const symbol of symbols) {
    if ("location" in symbol) {
      continue;
    }

    if (
      symbol.name === fieldName &&
      (symbol.kind === getVscode().SymbolKind.Field ||
        symbol.kind === getVscode().SymbolKind.Property)
    ) {
      return symbol;
    }

    const nested = findFieldSymbolInTree(symbol.children, fieldName);

    if (nested) {
      return nested;
    }
  }

  return undefined;
}

async function openRustDocument(
  filePath: string
): Promise<VsCodeDocument | undefined> {
  try {
    return await getVscode().workspace.openTextDocument(getVscode().Uri.file(filePath));
  } catch {
    return undefined;
  }
}

async function getEnclosingUsageSymbol(
  uri: VsCodeUri,
  position: VsCodePosition
): Promise<VsCodeDocumentSymbol | VsCodeSymbolInformation | undefined> {
  const vscode = getVscode();
  const symbols = await vscode.commands.executeCommand<
    Array<import("vscode").DocumentSymbol | import("vscode").SymbolInformation>
  >("vscode.executeDocumentSymbolProvider", uri);

  if (!symbols) {
    return undefined;
  }

  return findEnclosingSymbol(symbols, position);
}

function findEnclosingSymbol(
  symbols: Array<VsCodeDocumentSymbol | VsCodeSymbolInformation>,
  position: VsCodePosition
): VsCodeDocumentSymbol | VsCodeSymbolInformation | undefined {
  let bestMatch:
    | VsCodeDocumentSymbol
    | VsCodeSymbolInformation
    | undefined;

  for (const symbol of symbols) {
    if ("location" in symbol) {
      if (symbol.location.range.contains(position)) {
        bestMatch = symbol;
      }

      continue;
    }

    if (!symbol.range.contains(position)) {
      continue;
    }

    const nestedMatch = findEnclosingSymbol(symbol.children, position);
    bestMatch = nestedMatch ?? symbol;
  }

  return bestMatch;
}

function getSymbolRange(
  symbol: VsCodeDocumentSymbol | VsCodeSymbolInformation | undefined
): VsCodeRange | undefined {
  if (!symbol) {
    return undefined;
  }

  return "location" in symbol ? symbol.location.range : symbol.range;
}

function mapWorkspaceSymbolKind(
  kind: import("vscode").SymbolKind
): SymbolNode["kind"] {
  const vscode = getVscode();

  switch (kind) {
    case vscode.SymbolKind.Struct:
      return "struct";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.Interface:
      return "trait";
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

function extractNodeSnippet(
  document: VsCodeDocument,
  node: SymbolNode,
  compact: boolean
): string | undefined {
  const startLine = Math.max(node.span.startLine - 1, 0);
  const endLine = Math.min(node.span.endLine - 1, document.lineCount - 1);

  if (startLine > endLine || endLine < 0) {
    return node.signature;
  }

  const lines: string[] = [];
  const maxLines = compact ? COMPACT_SNIPPET_MAX_LINES : Number.POSITIVE_INFINITY;

  for (
    let lineIndex = startLine;
    lineIndex <= endLine && lines.length < maxLines;
    lineIndex += 1
  ) {
    lines.push(document.lineAt(lineIndex).text);
  }

  if (compact && endLine - startLine + 1 > maxLines) {
    lines.push("// ...");
  }

  return lines.join("\n");
}

function extractRangeSnippet(
  document: VsCodeDocument,
  range: VsCodeRange,
  maxLines: number
): string {
  const startLine = Math.max(range.start.line, 0);
  const endLine = Math.min(range.end.line, document.lineCount - 1);
  const lines: string[] = [];

  for (
    let lineIndex = startLine;
    lineIndex <= endLine && lines.length < maxLines;
    lineIndex += 1
  ) {
    lines.push(document.lineAt(lineIndex).text);
  }

  if (endLine - startLine + 1 > maxLines) {
    lines.push("// ...");
  }

  return lines.join("\n").trim();
}

function createNodeMetadata(
  node: SymbolNode,
  extraMetadata: EvidenceMetadata = {}
): EvidenceMetadata {
  return {
    nodeId: node.id,
    symbolName: node.name,
    filePath: node.filePath,
    modulePath: node.modulePath,
    symbolKind: node.kind,
    startLine: node.span.startLine,
    endLine: node.span.endLine,
    ...extraMetadata
  };
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function getVscode(): VscodeModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("vscode") as VscodeModule;
}
