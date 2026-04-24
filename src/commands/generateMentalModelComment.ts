import * as vscode from "vscode";

import { createAnalysisOrchestrator } from "../analysis/analysisOrchestrator";
import { getExtensionConfiguration } from "../core/configuration";
import type { Logger } from "../core/logger";
import { EvidenceRepository } from "../evidence/evidenceRepository";
import { collectRustSymbolContextReport } from "../features/rust/rustSymbolContextCollector";
import { createRustEvidenceRetriever } from "../features/rust/rustEvidenceRetriever";
import { createCommentGenerationService } from "../services/commentGenerationService";
import { createHypothesisGenerationService } from "../services/hypothesisGenerationService";
import { createEvidenceRanker } from "../ranking/evidenceRanker";
import { createRetrievalPlanner } from "../retrieval/retrievalPlanner";

export const GENERATE_MENTAL_MODEL_COMMENT_COMMAND =
  "semantic-codesense.generateMentalModelComment";

export function registerGenerateMentalModelCommentCommand(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  const configuration = getExtensionConfiguration();
  const service = createCommentGenerationService(
    logger,
    configuration
  );
  const hypothesisGenerator = createHypothesisGenerationService(
    logger,
    configuration
  );

  const disposable = vscode.commands.registerCommand(
    GENERATE_MENTAL_MODEL_COMMENT_COMMAND,
    async () => {
      try {
        logger.show(true);
        logger.info("Generate Mental Model Comment command invoked.");

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Semantic CodeSense",
            cancellable: false
          },
          async (progress) => {
            progress.report({ message: "Checking active Rust symbol..." });

            const editor = vscode.window.activeTextEditor;

            if (!editor) {
              logger.warn("Generate command aborted: no active editor.");
              void vscode.window.showWarningMessage(
                "Open a Rust file before using Semantic CodeSense."
              );
              return;
            }

            logger.info(
              `Generate command active document: ${editor.document.uri.toString()} at line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}.`
            );

            if (editor.document.languageId !== "rust") {
              logger.warn(
                `Generate command aborted: active document language is "${editor.document.languageId}".`
              );
              void vscode.window.showWarningMessage(
                "Semantic CodeSense is currently available for Rust files only."
              );
              return;
            }

            progress.report({ message: "Collecting Rust symbol context..." });
            logger.info("Collecting Rust symbol context report for current cursor.");
            const report = await collectRustSymbolContextReport(
              editor.document,
              editor.selection.active,
              logger
            );

            if (!report) {
              logger.warn(
                `Generate command could not resolve a Rust symbol at line ${editor.selection.active.line + 1}.`
              );
              void vscode.window.showWarningMessage(
                "Semantic CodeSense could not resolve a Rust symbol at the current cursor position."
              );
              return;
            }

            logger.info(
              `Resolved target symbol for generation: ${report.targetNode.kind} "${report.targetNode.name}" in module "${report.targetNode.modulePath}".`
            );

            progress.report({ message: "Running bounded analysis loop..." });
            logger.info("Running bounded analysis loop before final summarization.");
            const evidenceRepository = new EvidenceRepository(report.evidenceStore);
            const analysisOrchestrator = createAnalysisOrchestrator(
              hypothesisGenerator,
              createRetrievalPlanner(),
              createRustEvidenceRetriever(evidenceRepository),
              createEvidenceRanker()
            );
            const analysis = await analysisOrchestrator.analyze({
              targetNode: report.targetNode,
              initialEvidence: report.evidenceArtifacts
            });
            const enrichedReport = {
              ...report,
              evidenceArtifacts: analysis.allEvidence,
              rankedEvidence: analysis.rankedEvidence,
              finalDraft: analysis.finalDraft,
              draftsByRound: analysis.draftsByRound,
              executedActionsByRound: analysis.executedActionsByRound,
              stopReason: analysis.stopReason,
              analysis
            };

            logger.info(
              `Analysis loop completed for ${report.targetNode.name}: stopReason=${analysis.stopReason}, drafts=${analysis.draftsByRound.length}, rankedArtifacts=${analysis.rankedEvidence.length}.`
            );

            const focusText =
              editor.document.getText(editor.selection).trim() ||
              enrichedReport.targetNode.signature ||
              enrichedReport.targetNode.name;

            progress.report({ message: "Requesting Ollama summary..." });
            logger.info("Requesting semantic summary from Ollama.");
            const result = await service.generate({
              documentUri: editor.document.uri.toString(),
              sourceText: editor.document.getText(),
              focusText,
              targetNode: enrichedReport.targetNode,
              context: enrichedReport.symbolContext,
              graph: enrichedReport.graph,
              evidenceArtifacts: enrichedReport.rankedEvidence?.map(
                (rankedArtifact) => rankedArtifact.artifact
              ) ?? enrichedReport.evidenceArtifacts
            });

            logger.info(
              `Semantic summary generation completed with status "${result.status}".`
            );

            if (result.status !== "success" || !result.markdown) {
              logger.warn(`Semantic summary generation failed: ${result.message}`);
              void vscode.window.showWarningMessage(result.message);
              return;
            }

            progress.report({ message: "Opening generated summary..." });
            const reportDocument = await vscode.workspace.openTextDocument({
              language: "markdown",
              content: result.markdown
            });

            await vscode.window.showTextDocument(reportDocument, {
              preview: false,
              viewColumn: vscode.ViewColumn.Beside
            });

            void vscode.window.showInformationMessage(result.message);
          }
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown generation failure.";
        logger.error(`Generate command failed before completion: ${message}`);
        void vscode.window.showErrorMessage(
          `Semantic CodeSense generation failed: ${message}`
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}
