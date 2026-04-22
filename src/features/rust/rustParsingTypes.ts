import type { SymbolNode } from "../../types/graph";

export interface RustSourcePosition {
  line: number;
  character: number;
}

export interface RustImplBinding {
  implSymbolId: string;
  targetTypeName: string;
  traitName?: string;
}

export interface RustImportBinding {
  ownerSymbolId: string;
  importedNames: string[];
}

export interface RustCallBinding {
  ownerSymbolId: string;
  targetName: string;
  targetKindHint: "function" | "method";
  sourcePosition: RustSourcePosition;
}

export interface RustTypeBinding {
  ownerSymbolId: string;
  typeName: string;
}

export interface RustSyntaxParseResult {
  filePath: string;
  modulePath: string;
  rootModule: SymbolNode;
  symbols: SymbolNode[];
  implBindings: RustImplBinding[];
  importBindings: RustImportBinding[];
  callBindings: RustCallBinding[];
  typeBindings: RustTypeBinding[];
  hasErrors: boolean;
}
