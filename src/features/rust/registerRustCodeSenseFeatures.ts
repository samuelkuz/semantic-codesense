import * as vscode from "vscode";

import { getExtensionConfiguration } from "../../core/configuration";
import type { Logger } from "../../core/logger";
import { GENERATE_MENTAL_MODEL_COMMENT_COMMAND } from "../../commands/generateMentalModelComment";
import { collectRustSymbols } from "./rustSymbolExtractor";

const RUST_SELECTOR: vscode.DocumentSelector = [
  { language: "rust", scheme: "file" },
  { language: "rust", scheme: "untitled" }
];

class RustMentalModelCodeActionProvider
  implements vscode.CodeActionProvider
{
  provideCodeActions(
    document: vscode.TextDocument
  ): vscode.CodeAction[] {
    if (document.languageId !== "rust" || !getExtensionConfiguration().enabled) {
      return [];
    }

    const action = new vscode.CodeAction(
      "Generate mental model comment",
      vscode.CodeActionKind.RefactorRewrite
    );

    action.command = {
      command: GENERATE_MENTAL_MODEL_COMMENT_COMMAND,
      title: "Generate mental model comment"
    };
    action.isPreferred = true;

    return [action];
  }
}

class RustMentalModelCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const configuration = getExtensionConfiguration();

    if (
      document.languageId !== "rust" ||
      !configuration.enabled ||
      !configuration.showCodeLens
    ) {
      return [];
    }

    return collectRustSymbols(document.getText(), document.uri.fsPath).map(
      (symbol) => {
        const lineIndex = Math.max(symbol.span.startLine - 1, 0);
        const range = new vscode.Range(lineIndex, 0, lineIndex, 0);

        return new vscode.CodeLens(range, {
          command: GENERATE_MENTAL_MODEL_COMMENT_COMMAND,
          title: "Generate mental model comment"
        });
      }
    );
  }
}

export function registerRustCodeSenseFeatures(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      RUST_SELECTOR,
      new RustMentalModelCodeActionProvider(),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]
      }
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      RUST_SELECTOR,
      new RustMentalModelCodeLensProvider()
    )
  );

  logger.info("Registered Rust editor scaffolding for Semantic CodeSense.");
}
