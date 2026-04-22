import path from "node:path";

import * as vscode from "vscode";
import Parser from "tree-sitter";
import RustLanguage from "tree-sitter-rust";

import type { Logger } from "../../core/logger";
import type { CargoWorkspaceContext } from "./rustCargoMetadata";
import type { RepositoryGraph, SymbolContext, SymbolNode } from "../../types/graph";
import { inferRustModulePath } from "./rustCargoMetadata";
import { buildRustFileGraph, findNearestSymbolByLine, getSymbolContext } from "./rustGraphBuilder";
import { buildRustFileGraphWithLsp } from "./rustGraphLspAugmenter";
import { collectRustLspSnapshot } from "./rustLspClient";
import { parseRustSyntaxFile } from "./rustTreeSitterParser";

const CONTEXT_TREE_SITTER_PARSER = new Parser();

CONTEXT_TREE_SITTER_PARSER.setLanguage(
  RustLanguage as unknown as Parser.Language
);

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

export interface RustSymbolContextReport {
  title: string;
  markdown: string;
  targetNode: SymbolNode;
  graph: RepositoryGraph;
  symbolContext?: SymbolContext;
}

export async function collectRustSymbolContextReport(
  document: vscode.TextDocument,
  position: vscode.Position,
  logger: Logger
): Promise<RustSymbolContextReport | undefined> {
  const filePath = document.uri.fsPath || path.basename(document.uri.path);
  const sourceText = document.getText();
  const syntax = parseRustSyntaxFile({
    filePath,
    sourceText
  });
  const baseGraph = buildRustFileGraph({
    filePath,
    sourceText
  });
  const { graph, cargoWorkspace } = await buildRustFileGraphWithLsp(
    document,
    baseGraph,
    syntax
  );
  const targetNode = findNearestSymbolByLine(graph, position.line + 1);

  if (!targetNode) {
    return undefined;
  }

  const symbolContext = getSymbolContext(graph, targetNode.id);

  if (!symbolContext) {
    return undefined;
  }

  logger.info(
    `Collecting symbol context for ${targetNode.kind} "${targetNode.name}" from ${filePath}.`
  );

  const targetSnippet = extractNodeSnippet(document, targetNode, false);
  const implNode = symbolContext.parents.find((node) => node.kind === "impl");
  const implSnippet = implNode
    ? await getSnippetForNode(implNode, document, true)
    : undefined;
  const ownerNode = findOwningTypeNode(graph, symbolContext, implNode);
  const ownerSnippet = ownerNode
    ? await getSnippetForNode(ownerNode, document, true)
    : undefined;
  const traitNode = findImplementedTraitNode(graph, implNode);
  const traitSnippet = traitNode
    ? await getSnippetForNode(traitNode, document, true)
    : undefined;
  const helperFunctions = await collectHelperFunctionSummaries(
    symbolContext,
    document
  );
  const importantTypes = await collectImportantTypeSummaries(
    symbolContext,
    document,
    cargoWorkspace
  );
  const constantSummaries = await collectReferencedConstantSummaries(
    document,
    targetNode,
    cargoWorkspace
  );
  const usageContext = await collectUsageContext(
    document,
    position,
    targetNode
  );

  const markdown = [
    `# Rust Symbol Context: ${targetNode.name}`,
    "",
    `Target: \`${targetNode.kind}\` in \`${targetNode.modulePath}\``,
    "",
    "## Core context",
    "",
    `- Module path: \`${targetNode.modulePath}\``,
    `- Signature: \`${targetNode.signature ?? targetNode.name}\``,
    `- Nearby comments/docstrings: ${targetNode.docs ? "present" : "none found"}`,
    "",
    targetNode.docs ? "### Docstrings / nearby comments" : "### Docstrings / nearby comments",
    "",
    targetNode.docs ? targetNode.docs : "_No docstrings or nearby comments found._",
    "",
    "### Full function body",
    "",
    fencedCode(targetSnippet, filePath),
    "",
    "### Surrounding impl block",
    "",
    implSnippet ? fencedCode(implSnippet, filePath) : "_No surrounding impl block found._",
    "",
    "### Struct / trait definition it belongs to",
    "",
    ownerSnippet
      ? fencedCode(ownerSnippet, ownerNode?.filePath ?? filePath)
      : "_No owning struct or trait definition found._",
    "",
    "## Dependency context",
    "",
    "### Helper functions it calls",
    "",
    helperFunctions.length > 0
      ? helperFunctions.map(formatDefinitionSummary).join("\n\n")
      : "_No helper functions found._",
    "",
    "### Important custom types in signature/body",
    "",
    importantTypes.length > 0
      ? importantTypes.map(formatDefinitionSummary).join("\n\n")
      : "_No important custom types found._",
    "",
    "### Referenced constants / configs",
    "",
    constantSummaries.length > 0
      ? constantSummaries.map(formatDefinitionSummary).join("\n\n")
      : "_No referenced constants or config-like symbols found._",
    "",
    "### Trait definition if behavior depends on trait methods",
    "",
    traitSnippet
      ? fencedCode(traitSnippet, traitNode?.filePath ?? filePath)
      : "_No implemented trait definition found._",
    "",
    "## Usage context",
    "",
    "### Top call sites",
    "",
    usageContext.callSites.length > 0
      ? usageContext.callSites.map(formatUsageSummary).join("\n\n")
      : "_No call sites found._",
    "",
    "### Tests that exercise it",
    "",
    usageContext.tests.length > 0
      ? usageContext.tests.map(formatUsageSummary).join("\n\n")
      : "_No test call paths found._",
    "",
    "### Higher-level entrypoints that eventually call it",
    "",
    usageContext.entrypoints.length > 0
      ? usageContext.entrypoints.map(formatUsageSummary).join("\n\n")
      : "_No higher-level entrypoints found._"
  ].join("\n");

  return {
    title: `Rust Symbol Context: ${targetNode.name}`,
    markdown,
    targetNode,
    graph,
    symbolContext
  };
}

interface DefinitionSummary {
  label: string;
  filePath: string;
  snippet?: string;
}

interface UsageSummary {
  label: string;
  filePath: string;
  line: number;
  snippet: string;
  callLine?: number;
  depth?: number;
}

async function collectHelperFunctionSummaries(
  symbolContext: SymbolContext,
  currentDocument: vscode.TextDocument
): Promise<DefinitionSummary[]> {
  const helperNodes = rankNodes(symbolContext.callees, (node) => {
    return (node.isExternal ? 100 : 0) + (node.filePath === currentDocument.uri.fsPath ? 0 : 10);
  }).slice(0, 8);

  const summaries = await Promise.all(
    helperNodes.map(async (node) => ({
      label: `${node.kind} \`${node.name}\``,
      filePath: node.filePath,
      snippet: await getSnippetForNode(node, currentDocument, true)
    }))
  );

  return summaries.slice(0, 8);
}

async function collectImportantTypeSummaries(
  symbolContext: SymbolContext,
  currentDocument: vscode.TextDocument,
  cargoWorkspace: CargoWorkspaceContext | undefined
): Promise<DefinitionSummary[]> {
  const types = symbolContext.relatedTypes
    .filter(
      (node) =>
        !COMMON_TYPE_NAMES.has(node.name) &&
        (node.kind === "struct" || node.kind === "enum" || node.kind === "trait")
    )
    .slice(0, 8);

  const summaries = await Promise.all(types.map(async (node) => {
    const resolvedNode = await resolveNodeViaWorkspaceSymbols(
      node,
      cargoWorkspace
    );

    return {
      label: `${(resolvedNode ?? node).kind} \`${(resolvedNode ?? node).name}\``,
      filePath: (resolvedNode ?? node).filePath,
      snippet: await getSnippetForNode(resolvedNode ?? node, currentDocument, true)
    };
  }));

  return summaries.filter((summary) => summary.snippet !== undefined);
}

async function collectReferencedConstantSummaries(
  document: vscode.TextDocument,
  targetNode: SymbolNode,
  cargoWorkspace: CargoWorkspaceContext | undefined
): Promise<DefinitionSummary[]> {
  const constantNames = collectConstantLikeIdentifiers(document, targetNode).slice(0, 8);
  const summaries: DefinitionSummary[] = [];

  for (const constantName of constantNames) {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      constantName
    );
    const matchingSymbol = (symbols ?? []).find((symbol) => {
      return (
        symbol.name === constantName &&
        (symbol.kind === vscode.SymbolKind.Constant ||
          symbol.kind === vscode.SymbolKind.Variable)
      );
    });

    if (!matchingSymbol) {
      continue;
    }

    const symbolNode: SymbolNode = {
      id: `rust:workspace-constant:${matchingSymbol.location.uri.toString()}:${matchingSymbol.name}:${matchingSymbol.location.range.start.line + 1}`,
      name: matchingSymbol.name,
      kind: "module",
      filePath: matchingSymbol.location.uri.fsPath || matchingSymbol.location.uri.path,
      modulePath: inferRustModulePath(
        matchingSymbol.location.uri.fsPath || matchingSymbol.location.uri.path,
        cargoWorkspace
      ),
      span: {
        startLine: matchingSymbol.location.range.start.line + 1,
        endLine: matchingSymbol.location.range.end.line + 1
      },
      language: "rust"
    };

    summaries.push({
      label: `constant/config \`${matchingSymbol.name}\``,
      filePath: symbolNode.filePath,
      snippet: await getSnippetForNode(symbolNode, document, true)
    });
  }

  return summaries.slice(0, 8);
}

async function collectUsageContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  targetNode: SymbolNode
): Promise<{
  callSites: UsageSummary[];
  tests: UsageSummary[];
  entrypoints: UsageSummary[];
}> {
  const declarationPosition = findDeclarationPosition(document, targetNode) ?? position;
  const snapshot = await collectRustLspSnapshot(document, declarationPosition);
  const callHierarchyItems = await vscode.commands.executeCommand<
    vscode.CallHierarchyItem[]
  >("vscode.prepareCallHierarchy", document.uri, declarationPosition);
  const rootItem = callHierarchyItems?.[0];
  const directCallSitesFromHierarchy = await Promise.all(
    (snapshot?.incomingCalls ?? [])
      .slice(0, 8)
      .map(async (call: vscode.CallHierarchyIncomingCall) =>
        usageSummaryFromCallHierarchyItem(call.from, call.fromRanges[0], 1)
      )
  );
  const exploredCallers = rootItem
    ? await exploreIncomingCallHierarchy(rootItem, 3)
    : [];
  const referenceFallback: {
    callSites: UsageSummary[];
    tests: UsageSummary[];
    entrypoints: UsageSummary[];
  } = directCallSitesFromHierarchy.length === 0
    ? await collectReferenceFallbackUsage(document, declarationPosition, targetNode)
    : {
        callSites: [],
        tests: [],
        entrypoints: []
      };
  const directCallSites = directCallSitesFromHierarchy.length > 0
    ? directCallSitesFromHierarchy.filter((item): item is UsageSummary => item !== undefined)
    : referenceFallback.callSites;
  const tests = exploredCallers
    .filter((item) => item.isTestLike)
    .slice(0, 8)
    .map((item) => item.summary)
    .concat(referenceFallback.tests)
    .slice(0, 8);
  const entrypoints = exploredCallers
    .filter(
      (item: { summary: UsageSummary; depth: number; isTestLike: boolean }) =>
        !item.isTestLike && item.summary.label !== targetNode.name
    )
    .sort((left, right) => right.depth - left.depth)
    .slice(0, 2)
    .map((item) => item.summary);
  const fallbackEntrypoints = entrypoints.length > 0
    ? entrypoints
    : referenceFallback.entrypoints.slice(0, 2);

  return {
    callSites: directCallSites,
    tests,
    entrypoints: fallbackEntrypoints
  };
}

async function exploreIncomingCallHierarchy(
  rootItem: vscode.CallHierarchyItem,
  maxDepth: number
): Promise<Array<{ summary: UsageSummary; depth: number; isTestLike: boolean }>> {
  const queue: Array<{ item: vscode.CallHierarchyItem; depth: number }> = [
    { item: rootItem, depth: 0 }
  ];
  const visited = new Set<string>([
    createCallHierarchyKey(rootItem)
  ]);
  const results: Array<{ summary: UsageSummary; depth: number; isTestLike: boolean }> = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= maxDepth) {
      continue;
    }

    const incomingCalls = await vscode.commands.executeCommand<
      vscode.CallHierarchyIncomingCall[]
    >("vscode.provideIncomingCalls", current.item);

    for (const incomingCall of incomingCalls ?? []) {
      const caller = incomingCall.from;
      const callerKey = createCallHierarchyKey(caller);

      if (visited.has(callerKey)) {
        continue;
      }

      visited.add(callerKey);

      const summary = await usageSummaryFromCallHierarchyItem(
        caller,
        incomingCall.fromRanges[0],
        current.depth + 1
      );

      if (!summary) {
        continue;
      }

      const isTestLike = await isTestLikeCallHierarchyItem(caller);

      results.push({
        summary,
        depth: current.depth + 1,
        isTestLike
      });

      queue.push({
        item: caller,
        depth: current.depth + 1
      });
    }
  }

  return results;
}

async function usageSummaryFromCallHierarchyItem(
  item: vscode.CallHierarchyItem,
  fromRange: vscode.Range | undefined,
  depth: number
): Promise<UsageSummary | undefined> {
  const document = await vscode.workspace.openTextDocument(item.uri);
  const callLineNumber = fromRange?.start.line ?? item.selectionRange.start.line;
  const snippet = extractRangeSnippet(document, item.range, 60);

  return {
    label: item.name,
    filePath: item.uri.fsPath || item.uri.path,
    line: item.range.start.line + 1,
    callLine: callLineNumber + 1,
    snippet: snippet || item.detail || item.name,
    depth
  };
}

async function isTestLikeCallHierarchyItem(
  item: vscode.CallHierarchyItem
): Promise<boolean> {
  const filePath = item.uri.fsPath || item.uri.path;

  if (
    /(^|\/)(tests?|benches)\//.test(filePath) ||
    /^test_/.test(item.name) ||
    /test/i.test(item.name)
  ) {
    return true;
  }

  try {
    const document = await vscode.workspace.openTextDocument(item.uri);
    const startLine = Math.max(item.range.start.line - 3, 0);
    const endLine = Math.min(item.range.start.line + 1, document.lineCount - 1);

    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
      if (document.lineAt(lineIndex).text.includes("#[test]")) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function collectConstantLikeIdentifiers(
  document: vscode.TextDocument,
  targetNode: SymbolNode
): string[] {
  const tree = CONTEXT_TREE_SITTER_PARSER.parse(document.getText());
  const identifiers = new Set<string>();

  walkSyntaxTree(tree.rootNode, (node) => {
    if (
      node.startPosition.row + 1 < targetNode.span.startLine ||
      node.endPosition.row + 1 > targetNode.span.endLine
    ) {
      return undefined;
    }

    if (
      node.type === "identifier" &&
      /^[A-Z][A-Z0-9_]+$/.test(node.text.trim())
    ) {
      identifiers.add(node.text.trim());
    }

    return undefined;
  });

  return [...identifiers];
}

function findOwningTypeNode(
  graph: RepositoryGraph,
  symbolContext: SymbolContext,
  implNode: SymbolNode | undefined
): SymbolNode | undefined {
  if (!implNode) {
    return symbolContext.parents.find(
      (node) => node.kind === "struct" || node.kind === "trait" || node.kind === "enum"
    );
  }

  const ownerEdge = graph.edges.find((edge) => {
    if (edge.from !== implNode.id || edge.kind !== "belongs_to") {
      return false;
    }

    const candidateNode = graph.nodes.find((node) => node.id === edge.to);

    return (
      candidateNode?.kind === "struct" ||
      candidateNode?.kind === "trait" ||
      candidateNode?.kind === "enum"
    );
  });

  return ownerEdge
    ? graph.nodes.find((node) => node.id === ownerEdge.to)
    : undefined;
}

function findImplementedTraitNode(
  graph: RepositoryGraph,
  implNode: SymbolNode | undefined
): SymbolNode | undefined {
  if (!implNode) {
    return undefined;
  }

  const traitEdge = graph.edges.find(
    (edge) => edge.from === implNode.id && edge.kind === "implements"
  );

  return traitEdge ? graph.nodes.find((node) => node.id === traitEdge.to) : undefined;
}

async function getSnippetForNode(
  node: SymbolNode,
  currentDocument: vscode.TextDocument,
  compact: boolean
): Promise<string | undefined> {
  if (node.isExternal) {
    return node.signature;
  }

  const document =
    normalizeFilePath(currentDocument.uri.fsPath || currentDocument.uri.path) ===
    normalizeFilePath(node.filePath)
      ? currentDocument
      : await vscode.workspace.openTextDocument(vscode.Uri.file(node.filePath));

  return extractNodeSnippet(document, node, compact);
}

async function resolveNodeViaWorkspaceSymbols(
  node: SymbolNode,
  cargoWorkspace: CargoWorkspaceContext | undefined
): Promise<SymbolNode | undefined> {
  if (!node.isExternal) {
    return node;
  }

  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    node.name
  );
  const matchingSymbol = (symbols ?? []).find((symbol) => {
    if (symbol.name !== node.name) {
      return false;
    }

    return mapWorkspaceSymbolKind(symbol.kind) === node.kind;
  });

  if (!matchingSymbol) {
    return undefined;
  }

  return {
    id: `rust:workspace-symbol:${matchingSymbol.location.uri.toString()}:${matchingSymbol.name}:${matchingSymbol.location.range.start.line + 1}`,
    name: matchingSymbol.name,
    kind: mapWorkspaceSymbolKind(matchingSymbol.kind),
    filePath: matchingSymbol.location.uri.fsPath || matchingSymbol.location.uri.path,
    modulePath: inferRustModulePath(
      matchingSymbol.location.uri.fsPath || matchingSymbol.location.uri.path,
      cargoWorkspace
    ),
    span: {
      startLine: matchingSymbol.location.range.start.line + 1,
      endLine: matchingSymbol.location.range.end.line + 1
    },
    language: "rust"
  };
}

async function collectReferenceFallbackUsage(
  document: vscode.TextDocument,
  declarationPosition: vscode.Position,
  targetNode: SymbolNode
): Promise<{
  callSites: UsageSummary[];
  tests: UsageSummary[];
  entrypoints: UsageSummary[];
}> {
  const references = await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    document.uri,
    declarationPosition
  );
  const uniqueUsages = new Map<string, UsageSummary>();

  for (const reference of references ?? []) {
    if (
      normalizeFilePath(reference.uri.fsPath || reference.uri.path) ===
        normalizeFilePath(targetNode.filePath) &&
      reference.range.start.line + 1 === targetNode.span.startLine
    ) {
      continue;
    }

    const enclosingSymbol = await getEnclosingUsageSymbol(
      reference.uri,
      reference.range.start
    );
    const referenceDocument = await vscode.workspace.openTextDocument(reference.uri);
    const enclosingRange = getSymbolRange(enclosingSymbol);
    const snippet = enclosingRange
      ? extractRangeSnippet(referenceDocument, enclosingRange, 60)
      : referenceDocument.lineAt(reference.range.start.line).text.trim();
    const summary: UsageSummary = {
      label: enclosingSymbol?.name ?? path.basename(reference.uri.fsPath || reference.uri.path),
      filePath: reference.uri.fsPath || reference.uri.path,
      line: enclosingRange ? enclosingRange.start.line + 1 : reference.range.start.line + 1,
      callLine: reference.range.start.line + 1,
      snippet,
      depth: 1
    };

    uniqueUsages.set(
      `${summary.filePath}:${summary.line}:${summary.label}`,
      summary
    );
  }

  const usages = [...uniqueUsages.values()].slice(0, 8);
  const tests = usages.filter((usage) =>
    /(^|\/)(tests?|benches)\//.test(usage.filePath) || /test/i.test(usage.label)
  );
  const entrypoints = usages.filter(
    (usage) => !tests.includes(usage) && usage.label !== targetNode.name
  );

  return {
    callSites: usages,
    tests,
    entrypoints
  };
}

async function getEnclosingUsageSymbol(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<vscode.DocumentSymbol | vscode.SymbolInformation | undefined> {
  const symbols = await vscode.commands.executeCommand<
    Array<vscode.DocumentSymbol | vscode.SymbolInformation>
  >("vscode.executeDocumentSymbolProvider", uri);

  if (!symbols) {
    return undefined;
  }

  return findEnclosingSymbol(symbols, position);
}

function findEnclosingSymbol(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  position: vscode.Position
): vscode.DocumentSymbol | vscode.SymbolInformation | undefined {
  let bestMatch:
    | vscode.DocumentSymbol
    | vscode.SymbolInformation
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

function findDeclarationPosition(
  document: vscode.TextDocument,
  targetNode: SymbolNode
): vscode.Position | undefined {
  const declarationLineIndex = Math.max(targetNode.span.startLine - 1, 0);

  if (declarationLineIndex >= document.lineCount) {
    return undefined;
  }

  const lineText = document.lineAt(declarationLineIndex).text;
  const nameIndex = lineText.indexOf(targetNode.name);

  return new vscode.Position(
    declarationLineIndex,
    nameIndex >= 0 ? nameIndex : 0
  );
}

function mapWorkspaceSymbolKind(kind: vscode.SymbolKind): SymbolNode["kind"] {
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
  document: vscode.TextDocument,
  node: SymbolNode,
  compact: boolean
): string | undefined {
  const startLine = Math.max(node.span.startLine - 1, 0);
  const endLine = Math.min(node.span.endLine - 1, document.lineCount - 1);

  if (startLine > endLine || endLine < 0) {
    return node.signature;
  }

  const lines: string[] = [];
  const maxLines = compact ? 20 : Number.POSITIVE_INFINITY;

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

function rankNodes(nodes: SymbolNode[], score: (node: SymbolNode) => number): SymbolNode[] {
  return [...nodes].sort((left, right) => {
    const leftScore = score(left);
    const rightScore = score(right);

    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    return left.name.localeCompare(right.name);
  });
}

function formatDefinitionSummary(summary: DefinitionSummary): string {
  return [
    `- ${summary.label} in \`${summary.filePath}\``,
    "",
    summary.snippet ? fencedCode(summary.snippet, summary.filePath) : "_No snippet available._"
  ].join("\n");
}

function formatUsageSummary(summary: UsageSummary): string {
  const depthSuffix =
    summary.depth !== undefined ? ` (depth ${summary.depth})` : "";
  const callLineSuffix =
    summary.callLine !== undefined && summary.callLine !== summary.line
      ? `, call at line ${summary.callLine}`
      : "";

  return `- \`${summary.label}\` at \`${summary.filePath}:${summary.line}\`${callLineSuffix}${depthSuffix}\n\n\`\`\`rust\n${summary.snippet}\n\`\`\``;
}

function fencedCode(snippet: string | undefined, filePath: string): string {
  const language = path.extname(filePath) === ".rs" ? "rust" : "";
  return snippet ? `\`\`\`${language}\n${snippet}\n\`\`\`` : "_No snippet available._";
}

function createCallHierarchyKey(item: vscode.CallHierarchyItem): string {
  return `${item.uri.toString()}:${item.name}:${item.range.start.line}:${item.range.start.character}`;
}

function getSymbolRange(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation | undefined
): vscode.Range | undefined {
  if (!symbol) {
    return undefined;
  }

  return "location" in symbol ? symbol.location.range : symbol.range;
}

function extractRangeSnippet(
  document: vscode.TextDocument,
  range: vscode.Range,
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

function walkSyntaxTree(
  node: Parser.SyntaxNode,
  visitor: (currentNode: Parser.SyntaxNode) => boolean | void
): void {
  const shouldContinue = visitor(node);

  if (shouldContinue === false) {
    return;
  }

  for (const childNode of node.namedChildren) {
    walkSyntaxTree(childNode, visitor);
  }
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
