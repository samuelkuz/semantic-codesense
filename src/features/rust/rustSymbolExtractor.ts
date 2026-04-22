import type { SymbolNode } from "../../types/graph";

import { findNearestSymbolByLine } from "./rustGraphBuilder";
import { parseRustSyntaxFile } from "./rustTreeSitterParser";

export function collectRustSymbols(
  sourceText: string,
  filePath = "memory.rs"
): SymbolNode[] {
  const syntax = parseRustSyntaxFile({
    filePath,
    sourceText
  });

  return syntax.symbols;
}

export function findNearestRustSymbol(
  sourceText: string,
  zeroBasedLine: number,
  filePath = "memory.rs"
): SymbolNode | undefined {
  const syntax = parseRustSyntaxFile({
    filePath,
    sourceText
  });
  const graph = {
    language: "rust" as const,
    filePath: syntax.filePath,
    rootModuleId: syntax.rootModule.id,
    nodes: [syntax.rootModule, ...syntax.symbols],
    edges: []
  };

  return findNearestSymbolByLine(graph, zeroBasedLine + 1);
}
