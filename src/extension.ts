import * as vscode from "vscode";

import { registerGenerateMentalModelCommentCommand } from "./commands/generateMentalModelComment";
import { registerShowRustGraphDebugViewCommand } from "./commands/showRustGraphDebugView";
import { registerShowRustSymbolContextCommand } from "./commands/showRustSymbolContext";
import { createLogger } from "./core/logger";
import { registerRustCodeSenseFeatures } from "./features/rust/registerRustCodeSenseFeatures";

export function activate(context: vscode.ExtensionContext): void {
  const logger = createLogger();
  context.subscriptions.push(logger);
  logger.show(true);

  try {
    logger.info("Activating Semantic CodeSense.");

    registerGenerateMentalModelCommentCommand(context, logger);
    registerShowRustGraphDebugViewCommand(context, logger);
    registerShowRustSymbolContextCommand(context, logger);
    registerRustCodeSenseFeatures(context, logger);

    logger.info("Semantic CodeSense activated successfully.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown activation failure.";
    logger.error(`Semantic CodeSense activation failed: ${message}`);
    void vscode.window.showErrorMessage(
      `Semantic CodeSense failed to activate: ${message}`
    );
  }
}

export function deactivate(): void {}
