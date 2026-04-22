import * as vscode from "vscode";

export interface RustLspSnapshot {
  documentSymbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>;
  definitions: Array<vscode.Location | vscode.LocationLink>;
  references: vscode.Location[];
  hovers: vscode.Hover[];
  incomingCalls: vscode.CallHierarchyIncomingCall[];
  outgoingCalls: vscode.CallHierarchyOutgoingCall[];
}

export async function collectRustLspSnapshot(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<RustLspSnapshot | undefined> {
  if (document.languageId !== "rust") {
    return undefined;
  }

  const uri = document.uri;
  const [
    documentSymbols,
    definitions,
    references,
    hovers,
    callHierarchyItems
  ] = await Promise.all([
    vscode.commands.executeCommand<
      Array<vscode.DocumentSymbol | vscode.SymbolInformation>
    >("vscode.executeDocumentSymbolProvider", uri),
    vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      "vscode.executeDefinitionProvider",
      uri,
      position
    ),
    vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      position
    ),
    vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position
    ),
    vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      "vscode.prepareCallHierarchy",
      uri,
      position
    )
  ]);

  const primaryCallHierarchyItem = callHierarchyItems?.[0];
  const [incomingCalls, outgoingCalls] = primaryCallHierarchyItem
    ? await Promise.all([
        vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          "vscode.provideIncomingCalls",
          primaryCallHierarchyItem
        ),
        vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          "vscode.provideOutgoingCalls",
          primaryCallHierarchyItem
        )
      ])
    : [undefined, undefined];

  return {
    documentSymbols: documentSymbols ?? [],
    definitions: definitions ?? [],
    references: references ?? [],
    hovers: hovers ?? [],
    incomingCalls: incomingCalls ?? [],
    outgoingCalls: outgoingCalls ?? []
  };
}

export async function collectRustWorkspaceSymbols(
  query: string
): Promise<vscode.SymbolInformation[]> {
  const workspaceSymbols = await vscode.commands.executeCommand<
    vscode.SymbolInformation[]
  >("vscode.executeWorkspaceSymbolProvider", query);

  return workspaceSymbols ?? [];
}
