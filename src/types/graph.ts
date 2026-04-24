export type SupportedLanguage = "rust";

export type SymbolKind =
  | "function"
  | "struct"
  | "enum"
  | "trait"
  | "impl"
  | "method"
  | "module";

export interface SymbolNode {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  modulePath: string;
  signature?: string;
  docs?: string;
  parentSymbolId?: string;
  span: {
    startLine: number;
    endLine: number;
  };
  isExternal?: boolean;
  language?: SupportedLanguage;
}

export interface SymbolRef {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath?: string;
  modulePath?: string;
  language?: SupportedLanguage;
}

export interface Edge {
  from: string;
  to: string;
  kind:
    | "calls"
    | "called_by"
    | "uses_type"
    | "implements"
    | "belongs_to"
    | "references"
    | "imports";
}

export interface RepositoryGraph {
  language: SupportedLanguage;
  filePath: string;
  rootModuleId: string;
  nodes: SymbolNode[];
  edges: Edge[];
}

export interface SymbolContext {
  node: SymbolNode;
  parent?: SymbolNode;
  parents: SymbolNode[];
  children: SymbolNode[];
  outgoingEdges: Edge[];
  incomingEdges: Edge[];
  callees: SymbolNode[];
  callers: SymbolNode[];
  relatedTypes: SymbolNode[];
  importedSymbols: SymbolNode[];
}
