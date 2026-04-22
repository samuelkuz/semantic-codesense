import * as vscode from "vscode";

import { getExtensionConfiguration, type LogLevel } from "./configuration";

export interface Logger extends vscode.Disposable {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LOG_WEIGHTS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

class OutputChannelLogger implements Logger {
  private readonly channel = vscode.window.createOutputChannel(
    "Semantic CodeSense"
  );

  dispose(): void {
    this.channel.dispose();
  }

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  private write(level: LogLevel, message: string): void {
    const configuredLevel = getExtensionConfiguration().logLevel;

    if (LOG_WEIGHTS[level] > LOG_WEIGHTS[configuredLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

export function createLogger(): Logger {
  return new OutputChannelLogger();
}
