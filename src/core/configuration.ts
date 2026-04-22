import * as vscode from "vscode";

export type LogLevel = "error" | "warn" | "info" | "debug";
export type CommentTone = "concise" | "balanced" | "detailed";

export interface ExtensionConfiguration {
  enabled: boolean;
  commentTone: CommentTone;
  logLevel: LogLevel;
  showCodeLens: boolean;
}

const DEFAULT_CONFIGURATION: ExtensionConfiguration = {
  enabled: true,
  commentTone: "balanced",
  logLevel: "info",
  showCodeLens: false
};

export function getExtensionConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration("semanticCodesense");

  return {
    enabled: configuration.get<boolean>(
      "enabled",
      DEFAULT_CONFIGURATION.enabled
    ),
    commentTone: configuration.get<CommentTone>(
      "commentTone",
      DEFAULT_CONFIGURATION.commentTone
    ),
    logLevel: configuration.get<LogLevel>(
      "logLevel",
      DEFAULT_CONFIGURATION.logLevel
    ),
    showCodeLens: configuration.get<boolean>(
      "showCodeLens",
      DEFAULT_CONFIGURATION.showCodeLens
    )
  };
}
