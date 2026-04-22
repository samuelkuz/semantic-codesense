import * as vscode from "vscode";

import { registerGenerateMentalModelCommentCommand } from "./commands/generateMentalModelComment";
import { registerShowRustGraphDebugViewCommand } from "./commands/showRustGraphDebugView";
import { registerShowRustSymbolContextCommand } from "./commands/showRustSymbolContext";
import { createLogger } from "./core/logger";
import { registerRustCodeSenseFeatures } from "./features/rust/registerRustCodeSenseFeatures";

export function activate(context: vscode.ExtensionContext): void {
  const logger = createLogger();
  context.subscriptions.push(logger);

  logger.info("Activating Semantic CodeSense.");

  registerGenerateMentalModelCommentCommand(context, logger);
  registerShowRustGraphDebugViewCommand(context, logger);
  registerShowRustSymbolContextCommand(context, logger);
  registerRustCodeSenseFeatures(context, logger);

  logger.info("Semantic CodeSense activated successfully.");
}

export function deactivate(): void {}
