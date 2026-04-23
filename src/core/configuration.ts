import * as vscode from "vscode";

export type LogLevel = "error" | "warn" | "info" | "debug";
export type CommentTone = "concise" | "balanced" | "detailed";

export interface ExtensionConfiguration {
  enabled: boolean;
  commentTone: CommentTone;
  logLevel: LogLevel;
  showCodeLens: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
}

const DEFAULT_CONFIGURATION: ExtensionConfiguration = {
  enabled: true,
  commentTone: "balanced",
  logLevel: "info",
  showCodeLens: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "qwen3-coder:30b"
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
    ),
    ollamaBaseUrl: configuration.get<string>(
      "ollamaBaseUrl",
      DEFAULT_CONFIGURATION.ollamaBaseUrl
    ),
    ollamaModel: configuration.get<string>(
      "ollamaModel",
      DEFAULT_CONFIGURATION.ollamaModel
    )
  };
}
