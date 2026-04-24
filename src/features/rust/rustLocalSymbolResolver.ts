import type { SymbolNode } from "../../types/graph";

import { buildRustFileGraph } from "./rustGraphBuilder";
import { parseRustSyntaxFile } from "./rustTreeSitterParser";

interface LocalSymbolLookupTarget {
  filePath: string;
  name: string;
  kind?: string;
  startLine?: number;
}

export function findBestLocalSymbolNodeForLookup(
  target: LocalSymbolLookupTarget,
  sourceText: string
): SymbolNode | undefined {
  const graph = buildRustFileGraph({
    filePath: target.filePath,
    sourceText
  });
  const exactMatch = graph.nodes.find(
    (node) =>
      !node.isExternal &&
      node.name === target.name &&
      node.kind === target.kind &&
      node.span.startLine === target.startLine
  );

  if (exactMatch) {
    return exactMatch;
  }

  const kindMatch = graph.nodes.find(
    (node) =>
      !node.isExternal &&
      node.name === target.name &&
      node.kind === target.kind
  );

  if (kindMatch) {
    return kindMatch;
  }

  const syntax = parseRustSyntaxFile({
    filePath: target.filePath,
    sourceText
  });
  const syntaxExactMatch = syntax.symbols.find(
    (node) =>
      node.name === target.name &&
      node.kind === target.kind &&
      node.span.startLine === target.startLine
  );

  if (syntaxExactMatch) {
    return syntaxExactMatch;
  }

  return syntax.symbols.find(
    (node) => node.name === target.name && node.kind === target.kind
  );
}

export function resolveNodeToFullLocalSpan(
  node: SymbolNode,
  sourceText: string
): SymbolNode {
  if (node.isExternal) {
    return node;
  }

  return findBestLocalSymbolNodeForLookup(
    {
      filePath: node.filePath,
      name: node.name,
      kind: node.kind,
      startLine: node.span.startLine
    },
    sourceText
  ) ?? node;
}
