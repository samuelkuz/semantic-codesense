import * as vscode from "vscode";
import path from "node:path";

import type { Logger } from "../core/logger";
import {
  buildRustFileGraph,
  findNearestSymbolByLine,
  getSymbolContext
} from "../features/rust/rustGraphBuilder";
import { createCommentGenerationService } from "../services/commentGenerationService";
import type { SymbolNode } from "../types/graph";

export const GENERATE_MENTAL_MODEL_COMMENT_COMMAND =
  "semantic-codesense.generateMentalModelComment";

export function registerGenerateMentalModelCommentCommand(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  const service = createCommentGenerationService(logger);

  const disposable = vscode.commands.registerCommand(
    GENERATE_MENTAL_MODEL_COMMENT_COMMAND,
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showWarningMessage(
          "Open a Rust file before using Semantic CodeSense."
        );
        return;
      }

      if (editor.document.languageId !== "rust") {
        void vscode.window.showWarningMessage(
          "Semantic CodeSense is currently scaffolded for Rust files only."
        );
        return;
      }

      const graph = buildRustFileGraph({
        filePath:
          editor.document.uri.fsPath || path.basename(editor.document.uri.path),
        sourceText: editor.document.getText()
      });
      const symbol =
        findNearestSymbolByLine(graph, editor.selection.active.line + 1) ??
        createFallbackSymbol(editor);
      const context = getSymbolContext(graph, symbol.id);

      const focusText =
        editor.document.getText(editor.selection).trim() ||
        symbol.signature ||
        symbol.name;

      const result = await service.generate({
        documentUri: editor.document.uri.toString(),
        sourceText: editor.document.getText(),
        focusText,
        targetNode: symbol,
        context,
        graph
      });

      logger.info(
        `Placeholder command invoked for ${symbol.kind} "${symbol.name}".`
      );

      void vscode.window.showInformationMessage(result.message);
    }
  );

  context.subscriptions.push(disposable);
}

function createFallbackSymbol(
  editor: vscode.TextEditor
): SymbolNode {
  const line = editor.selection.active.line;
  const currentLine = editor.document.lineAt(line).text.trim() || "selection";

  return {
    id: `rust:fallback:${line + 1}:${currentLine}`,
    filePath: editor.document.uri.fsPath || "memory.rs",
    modulePath: "memory",
    language: "rust",
    kind: "function",
    name: "selection",
    span: {
      startLine: line + 1,
      endLine: line + 1
    },
    signature: currentLine
  };
}
