import path from "node:path";

import * as vscode from "vscode";

import { EvidenceOrchestrator } from "../../evidence/evidenceOrchestrator";
import { EvidenceRepository } from "../../evidence/evidenceRepository";
import type { Logger } from "../../core/logger";
import type { AnalysisLoopResult } from "../../types/analysis";
import {
  InMemoryEvidenceStore,
  type EvidenceArtifact,
  type EvidenceStore
} from "../../types/evidence";
import type { RepositoryGraph, SymbolContext, SymbolNode } from "../../types/graph";
import type { DraftHypothesis } from "../../types/hypothesis";
import type { RankedEvidence } from "../../types/ranking";
import { buildRustFileGraph, findNearestSymbolByLine, getSymbolContext } from "./rustGraphBuilder";
import { buildRustFileGraphWithLsp } from "./rustGraphLspAugmenter";
import { RustEvidenceCollector } from "./rustEvidenceCollector";
import { renderRustEvidenceArtifactsMarkdown } from "./rustEvidenceRenderer";
import { parseRustSyntaxFile } from "./rustTreeSitterParser";

export interface RustSymbolContextReport {
  title: string;
  markdown: string;
  targetNode: SymbolNode;
  graph: RepositoryGraph;
  symbolContext?: SymbolContext;
  evidenceStore: EvidenceStore;
  evidenceArtifacts: EvidenceArtifact[];
  rankedEvidence?: RankedEvidence[];
  finalDraft?: DraftHypothesis;
  draftsByRound?: DraftHypothesis[];
  executedActionsByRound?: AnalysisLoopResult["executedActionsByRound"];
  stopReason?: AnalysisLoopResult["stopReason"];
  analysis?: AnalysisLoopResult;
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

  const evidenceStore = new InMemoryEvidenceStore();
  const evidenceRepository = new EvidenceRepository(evidenceStore);
  const evidenceOrchestrator = new EvidenceOrchestrator(
    new RustEvidenceCollector(),
    evidenceRepository
  );
  const evidenceArtifacts = await evidenceOrchestrator.collectAndPersist({
    document,
    position,
    targetNode,
    symbolContext,
    graph,
    cargoWorkspace
  });
  const markdown = renderRustEvidenceArtifactsMarkdown(
    targetNode,
    evidenceArtifacts
  );

  return {
    title: `Rust Symbol Context: ${targetNode.name}`,
    markdown,
    targetNode,
    graph,
    symbolContext,
    evidenceStore,
    evidenceArtifacts
  };
}
