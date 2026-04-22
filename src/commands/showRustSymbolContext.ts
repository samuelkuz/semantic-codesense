import * as vscode from "vscode";

import type { Logger } from "../core/logger";
import { collectRustSymbolContextReport } from "../features/rust/rustSymbolContextCollector";

export const SHOW_RUST_SYMBOL_CONTEXT_COMMAND =
  "semantic-codesense.showRustSymbolContext";

export function registerShowRustSymbolContextCommand(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  const disposable = vscode.commands.registerCommand(
    SHOW_RUST_SYMBOL_CONTEXT_COMMAND,
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showWarningMessage(
          "Open a Rust file before collecting symbol context."
        );
        return;
      }

      if (editor.document.languageId !== "rust") {
        void vscode.window.showWarningMessage(
          "Semantic CodeSense context retrieval is currently available for Rust files only."
        );
        return;
      }

      const report = await collectRustSymbolContextReport(
        editor.document,
        editor.selection.active,
        logger
      );

      if (!report) {
        void vscode.window.showWarningMessage(
          "Semantic CodeSense could not resolve a symbol at the current cursor position."
        );
        return;
      }

      const reportDocument = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: report.markdown
      });

      await vscode.window.showTextDocument(reportDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
    }
  );

  context.subscriptions.push(disposable);
}
