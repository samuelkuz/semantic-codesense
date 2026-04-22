import * as vscode from "vscode";
import path from "node:path";

import type { Logger } from "../core/logger";
import { buildRustFileGraph, findNearestSymbolByLine, getSymbolContext } from "../features/rust/rustGraphBuilder";
import { buildRustFileGraphWithLsp } from "../features/rust/rustGraphLspAugmenter";
import { collectRustLspSnapshot } from "../features/rust/rustLspClient";
import { parseRustSyntaxFile } from "../features/rust/rustTreeSitterParser";

export const SHOW_RUST_GRAPH_DEBUG_VIEW_COMMAND =
  "semantic-codesense.showRustGraphDebugView";

export function registerShowRustGraphDebugViewCommand(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  const disposable = vscode.commands.registerCommand(
    SHOW_RUST_GRAPH_DEBUG_VIEW_COMMAND,
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showWarningMessage(
          "Open a Rust file before viewing the Semantic CodeSense graph."
        );
        return;
      }

      if (editor.document.languageId !== "rust") {
        void vscode.window.showWarningMessage(
          "Semantic CodeSense debug view is currently available for Rust files only."
        );
        return;
      }

      const filePath =
        editor.document.uri.fsPath || path.basename(editor.document.uri.path);
      const sourceText = editor.document.getText();
      const syntax = parseRustSyntaxFile({
        filePath,
        sourceText
      });
      const baseGraph = buildRustFileGraph({
        filePath,
        sourceText
      });
      const { graph, cargoWorkspace, lspSummary } =
        await buildRustFileGraphWithLsp(editor.document, baseGraph, syntax);
      const symbol =
        findNearestSymbolByLine(graph, editor.selection.active.line + 1) ?? null;
      const symbolContext = symbol ? getSymbolContext(graph, symbol.id) : undefined;
      const lspSnapshot = await collectRustLspSnapshot(
        editor.document,
        editor.selection.active
      );
      const debugPayload = {
        generatedAt: new Date().toISOString(),
        document: {
          uri: editor.document.uri.toString(),
          filePath,
          languageId: editor.document.languageId,
          selection: {
            line: editor.selection.active.line + 1,
            character: editor.selection.active.character
          }
        },
        parser: {
          syntaxHasErrors: syntax.hasErrors,
          symbolCount: syntax.symbols.length,
          callBindingCount: syntax.callBindings.length,
          typeBindingCount: syntax.typeBindings.length,
          importBindingCount: syntax.importBindings.length,
          implBindingCount: syntax.implBindings.length
        },
        syntax,
        lspAugmentation: lspSummary,
        baseGraph,
        graph,
        selectedSymbol: symbol,
        symbolContext,
        cargoWorkspace: cargoWorkspace ?? null,
        lsp: lspSnapshot ? serializeLspSnapshot(lspSnapshot) : null
      };
      const debugDocument = await vscode.workspace.openTextDocument({
        language: "json",
        content: JSON.stringify(debugPayload, null, 2)
      });

      logger.info(
        `Opened Rust graph debug view for ${filePath} with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`
      );

      await vscode.window.showTextDocument(debugDocument, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
      });
    }
  );

  context.subscriptions.push(disposable);
}

function serializeLspSnapshot(
  snapshot: Awaited<ReturnType<typeof collectRustLspSnapshot>>
): unknown {
  if (!snapshot) {
    return null;
  }

  return {
    documentSymbols: snapshot.documentSymbols.map((symbol) =>
      "location" in symbol
        ? {
            name: symbol.name,
            kind: symbol.kind,
            containerName: symbol.containerName,
            location: serializeLocation(symbol.location)
          }
        : {
            name: symbol.name,
            kind: symbol.kind,
            detail: symbol.detail,
            range: serializeRange(symbol.range),
            selectionRange: serializeRange(symbol.selectionRange),
            children: symbol.children.map((child) => ({
              name: child.name,
              kind: child.kind,
              detail: child.detail,
              range: serializeRange(child.range),
              selectionRange: serializeRange(child.selectionRange)
            }))
          }
    ),
    definitions: snapshot.definitions.map((definition) =>
      "targetUri" in definition
        ? {
            targetUri: definition.targetUri.toString(),
            targetRange: serializeRange(definition.targetRange),
            targetSelectionRange: serializeOptionalRange(
              definition.targetSelectionRange
            )
          }
        : serializeLocation(definition)
    ),
    references: snapshot.references.map(serializeLocation),
    hovers: snapshot.hovers.map((hover) => ({
      contents: hover.contents.map((content) =>
        typeof content === "string"
          ? content
          : "language" in content
            ? {
                language: content.language,
                value: content.value
              }
            : content.value
      ),
      range: hover.range ? serializeRange(hover.range) : null
    })),
    incomingCalls: snapshot.incomingCalls.map((call) => ({
      from: {
        name: call.from.name,
        kind: call.from.kind,
        uri: call.from.uri.toString(),
        range: serializeRange(call.from.range)
      },
      fromRanges: call.fromRanges.map(serializeRange)
    })),
    outgoingCalls: snapshot.outgoingCalls.map((call) => ({
      to: {
        name: call.to.name,
        kind: call.to.kind,
        uri: call.to.uri.toString(),
        range: serializeRange(call.to.range)
      },
      fromRanges: call.fromRanges.map(serializeRange)
    }))
  };
}

function serializeLocation(location: vscode.Location): unknown {
  return {
    uri: location.uri.toString(),
    range: serializeRange(location.range)
  };
}

function serializeRange(range: vscode.Range): unknown {
  return {
    start: {
      line: range.start.line + 1,
      character: range.start.character
    },
    end: {
      line: range.end.line + 1,
      character: range.end.character
    }
  };
}

function serializeOptionalRange(range: vscode.Range | undefined): unknown {
  return range ? serializeRange(range) : null;
}
