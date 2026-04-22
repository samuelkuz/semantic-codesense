import path from "node:path";

import Parser from "tree-sitter";
import RustLanguage from "tree-sitter-rust";

import type { SymbolKind, SymbolNode } from "../../types/graph";
import type {
  RustCallBinding,
  RustImplBinding,
  RustSyntaxParseResult,
  RustTypeBinding
} from "./rustParsingTypes";

interface ParseRustSyntaxFileOptions {
  filePath: string;
  sourceText: string;
  modulePath?: string;
}

interface SymbolVisitContext {
  parentSymbol: SymbolNode;
  modulePath: string;
}

const TREE_SITTER_PARSER = new Parser();
const SYMBOL_NODE_TYPES = new Set([
  "function_item",
  "function_signature_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item"
]);

TREE_SITTER_PARSER.setLanguage(RustLanguage as unknown as Parser.Language);

export function parseRustSyntaxFile(
  options: ParseRustSyntaxFileOptions
): RustSyntaxParseResult {
  const filePath = normalizeFilePath(options.filePath);
  const modulePath =
    options.modulePath ?? inferModulePathFromFilePath(filePath) ?? "crate";
  const lines = options.sourceText.split(/\r?\n/);
  const tree = TREE_SITTER_PARSER.parse(options.sourceText);
  const rootModule = createSymbolNode({
    filePath,
    modulePath,
    name: path.basename(modulePath),
    kind: "module",
    span: {
      startLine: 1,
      endLine: Math.max(lines.length, 1)
    }
  });
  const result: RustSyntaxParseResult = {
    filePath,
    modulePath,
    rootModule,
    symbols: [],
    implBindings: [],
    importBindings: [],
    callBindings: [],
    typeBindings: [],
    hasErrors: tree.rootNode.hasError
  };

  visitDeclarations(
    tree.rootNode,
    {
      parentSymbol: rootModule,
      modulePath
    },
    options.sourceText,
    lines,
    result
  );

  return result;
}

function visitDeclarations(
  syntaxNode: Parser.SyntaxNode,
  context: SymbolVisitContext,
  sourceText: string,
  lines: string[],
  result: RustSyntaxParseResult
): void {
  for (const childNode of syntaxNode.namedChildren) {
    if (childNode.type === "use_declaration") {
      const importedNames = extractImportedNames(childNode);

      if (importedNames.length > 0) {
        result.importBindings.push({
          ownerSymbolId: context.parentSymbol.id,
          importedNames
        });
      }

      continue;
    }

    if (!SYMBOL_NODE_TYPES.has(childNode.type)) {
      continue;
    }

    const symbol = createSymbolFromSyntaxNode(
      childNode,
      context,
      sourceText,
      lines
    );

    if (!symbol) {
      continue;
    }

    result.symbols.push(symbol);

    if (symbol.kind === "impl") {
      const implBinding = extractImplBinding(childNode, symbol);

      if (implBinding) {
        result.implBindings.push(implBinding);
      }
    }

    if (symbol.kind === "function" || symbol.kind === "method") {
      result.callBindings.push(...extractCallBindings(childNode, symbol));
      result.typeBindings.push(...extractTypeBindings(childNode, symbol));
    } else if (symbol.kind === "struct" || symbol.kind === "enum") {
      result.typeBindings.push(...extractTypeBindings(childNode, symbol));
    }

    if (symbol.kind === "module") {
      const bodyNode = childNode.childForFieldName("body");

      if (bodyNode) {
        visitDeclarations(
          bodyNode,
          {
            parentSymbol: symbol,
            modulePath: symbol.modulePath
          },
          sourceText,
          lines,
          result
        );
      }

      continue;
    }

    if (symbol.kind === "impl" || symbol.kind === "trait") {
      const bodyNode = childNode.childForFieldName("body");

      if (bodyNode) {
        visitDeclarations(
          bodyNode,
          {
            parentSymbol: symbol,
            modulePath: context.modulePath
          },
          sourceText,
          lines,
          result
        );
      }
    }
  }
}

function createSymbolFromSyntaxNode(
  syntaxNode: Parser.SyntaxNode,
  context: SymbolVisitContext,
  sourceText: string,
  lines: string[]
): SymbolNode | undefined {
  const kind = resolveSymbolKind(syntaxNode, context.parentSymbol.kind);

  if (!kind) {
    return undefined;
  }

  const name = extractSymbolName(syntaxNode, kind);

  if (!name) {
    return undefined;
  }

  const span = {
    startLine: syntaxNode.startPosition.row + 1,
    endLine: syntaxNode.endPosition.row + 1
  };
  const modulePath =
    kind === "module"
      ? `${context.modulePath}::${name}`
      : context.modulePath;

  return createSymbolNode({
    filePath: context.parentSymbol.filePath,
    modulePath,
    name,
    kind,
    parentSymbolId: context.parentSymbol.id,
    span,
    signature: extractSignatureText(syntaxNode, sourceText),
    docs: extractLeadingDocComments(lines, span.startLine)
  });
}

function createSymbolNode(input: {
  filePath: string;
  modulePath: string;
  name: string;
  kind: SymbolKind;
  span: {
    startLine: number;
    endLine: number;
  };
  signature?: string;
  docs?: string;
  parentSymbolId?: string;
}): SymbolNode {
  return {
    id: createLocalNodeId(
      input.filePath,
      input.modulePath,
      input.kind,
      input.name,
      input.span.startLine
    ),
    name: input.name,
    kind: input.kind,
    filePath: input.filePath,
    modulePath: input.modulePath,
    signature: input.signature,
    docs: input.docs,
    parentSymbolId: input.parentSymbolId,
    span: input.span,
    language: "rust"
  };
}

function resolveSymbolKind(
  syntaxNode: Parser.SyntaxNode,
  parentKind: SymbolKind
): SymbolKind | undefined {
  switch (syntaxNode.type) {
    case "function_item":
    case "function_signature_item":
      return parentKind === "impl" || parentKind === "trait"
        ? "method"
        : "function";
    case "struct_item":
      return "struct";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "trait";
    case "impl_item":
      return "impl";
    case "mod_item":
      return "module";
    default:
      return undefined;
  }
}

function extractSymbolName(
  syntaxNode: Parser.SyntaxNode,
  kind: SymbolKind
): string | undefined {
  if (kind === "impl") {
    const implBinding = extractImplBinding(syntaxNode, {
      id: "",
      name: "",
      kind: "impl",
      filePath: "",
      modulePath: "",
      span: {
        startLine: 0,
        endLine: 0
      }
    });

    if (!implBinding) {
      return undefined;
    }

    return implBinding.traitName
      ? `impl ${implBinding.traitName} for ${implBinding.targetTypeName}`
      : `impl ${implBinding.targetTypeName}`;
  }

  const nameNode = syntaxNode.childForFieldName("name");
  return nameNode?.text.trim();
}

function extractImplBinding(
  syntaxNode: Parser.SyntaxNode,
  implSymbol: SymbolNode
): RustImplBinding | undefined {
  const targetTypeNode = syntaxNode.childForFieldName("type");

  if (!targetTypeNode) {
    return undefined;
  }

  const traitNode = syntaxNode.childForFieldName("trait");

  return {
    implSymbolId: implSymbol.id,
    targetTypeName: extractBaseTypeName(targetTypeNode),
    traitName: traitNode ? extractBaseTypeName(traitNode) : undefined
  };
}

function extractCallBindings(
  syntaxNode: Parser.SyntaxNode,
  ownerSymbol: SymbolNode
): RustCallBinding[] {
  const bodyNode = syntaxNode.childForFieldName("body");

  if (!bodyNode) {
    return [];
  }

  const calls: RustCallBinding[] = [];

  walkSyntaxTree(bodyNode, (currentNode) => {
    if (currentNode.type !== "call_expression") {
      return;
    }

    const functionNode = currentNode.childForFieldName("function");

    if (!functionNode) {
      return;
    }

    const extractedCall = extractCallTarget(functionNode);

    if (!extractedCall) {
      return;
    }

    calls.push({
      ownerSymbolId: ownerSymbol.id,
      targetName: extractedCall.name,
      targetKindHint: extractedCall.kind,
      sourcePosition: extractedCall.sourcePosition
    });
  });

  return dedupeBindings(calls, (binding) => {
    return `${binding.ownerSymbolId}:${binding.targetKindHint}:${binding.targetName}`;
  });
}

function extractCallTarget(
  functionNode: Parser.SyntaxNode
): {
  name: string;
  kind: "function" | "method";
  sourcePosition: { line: number; character: number };
} | undefined {
  switch (functionNode.type) {
    case "identifier":
      return {
        name: functionNode.text.trim(),
        kind: "function",
        sourcePosition: {
          line: functionNode.startPosition.row + 1,
          character: functionNode.startPosition.column
        }
      };
    case "field_expression": {
      const fieldNode = functionNode.childForFieldName("field");

      return fieldNode
        ? {
            name: fieldNode.text.trim(),
            kind: "method",
            sourcePosition: {
              line: fieldNode.startPosition.row + 1,
              character: fieldNode.startPosition.column
            }
          }
        : undefined;
    }
    case "scoped_identifier": {
      const nameNode = functionNode.childForFieldName("name");

      return nameNode
        ? {
            name: nameNode.text.trim(),
            kind: "function",
            sourcePosition: {
              line: nameNode.startPosition.row + 1,
              character: nameNode.startPosition.column
            }
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

function extractTypeBindings(
  syntaxNode: Parser.SyntaxNode,
  ownerSymbol: SymbolNode
): RustTypeBinding[] {
  const typeNames = new Set<string>();

  walkSyntaxTree(syntaxNode, (currentNode) => {
    if (currentNode !== syntaxNode && SYMBOL_NODE_TYPES.has(currentNode.type)) {
      return false;
    }

    if (
      currentNode.type === "type_identifier" ||
      currentNode.type === "scoped_type_identifier"
    ) {
      const typeName = extractBaseTypeName(currentNode);

      if (typeName !== "" && typeName !== ownerSymbol.name) {
        typeNames.add(typeName);
      }
    }

    return undefined;
  });

  return [...typeNames].map((typeName) => ({
    ownerSymbolId: ownerSymbol.id,
    typeName
  }));
}

function extractImportedNames(useNode: Parser.SyntaxNode): string[] {
  const argumentNode = useNode.childForFieldName("argument");

  if (!argumentNode) {
    return [];
  }

  const importedNames = collectImportedNames(argumentNode);

  return [...new Set(importedNames)];
}

function collectImportedNames(syntaxNode: Parser.SyntaxNode): string[] {
  switch (syntaxNode.type) {
    case "identifier":
    case "type_identifier":
      return [syntaxNode.text.trim()];
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const nameNode = syntaxNode.childForFieldName("name");
      return nameNode ? [nameNode.text.trim()] : [];
    }
    case "scoped_use_list": {
      const listNode = syntaxNode.childForFieldName("list");
      return listNode ? collectImportedNames(listNode) : [];
    }
    case "use_list":
      return syntaxNode.namedChildren.flatMap((childNode) =>
        collectImportedNames(childNode)
      );
    default:
      return syntaxNode.namedChildren.flatMap((childNode) =>
        collectImportedNames(childNode)
      );
  }
}

function extractSignatureText(
  syntaxNode: Parser.SyntaxNode,
  sourceText: string
): string | undefined {
  const bodyNode = syntaxNode.childForFieldName("body");
  const endIndex = bodyNode?.startIndex ?? syntaxNode.endIndex;
  const signature = sourceText.slice(syntaxNode.startIndex, endIndex).trim();
  return signature === "" ? undefined : signature;
}

function extractLeadingDocComments(
  lines: string[],
  startLine: number
): string | undefined {
  const docs: string[] = [];

  for (let index = startLine - 2; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();

    if (trimmed.startsWith("#[")) {
      continue;
    }

    if (trimmed.startsWith("///") || trimmed.startsWith("//!")) {
      docs.unshift(trimmed.replace(/^\/\/[/!]\s?/, ""));
      continue;
    }

    break;
  }

  return docs.length > 0 ? docs.join("\n") : undefined;
}

function extractBaseTypeName(syntaxNode: Parser.SyntaxNode): string {
  switch (syntaxNode.type) {
    case "type_identifier":
    case "identifier":
    case "field_identifier":
      return syntaxNode.text.trim();
    case "scoped_type_identifier":
    case "scoped_identifier": {
      const nameNode = syntaxNode.childForFieldName("name");
      return nameNode?.text.trim() ?? syntaxNode.text.trim().split("::").pop() ?? "";
    }
    default: {
      const typeNode = syntaxNode.childForFieldName("type");

      if (typeNode) {
        return extractBaseTypeName(typeNode);
      }

      for (const childNode of syntaxNode.namedChildren) {
        const extractedName = extractBaseTypeName(childNode);

        if (extractedName !== "") {
          return extractedName;
        }
      }

      return "";
    }
  }
}

function walkSyntaxTree(
  syntaxNode: Parser.SyntaxNode,
  visitor: (node: Parser.SyntaxNode) => boolean | void
): void {
  const shouldStop = visitor(syntaxNode);

  if (shouldStop === false) {
    return;
  }

  for (const childNode of syntaxNode.namedChildren) {
    walkSyntaxTree(childNode, visitor);
  }
}

function dedupeBindings<T>(
  items: T[],
  getKey: (item: T) => string
): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = getKey(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function createLocalNodeId(
  filePath: string,
  modulePath: string,
  kind: SymbolKind,
  name: string,
  lineNumber: number
): string {
  return `rust:${filePath}:${modulePath}:${kind}:${name}:${lineNumber}`;
}

function inferModulePathFromFilePath(filePath: string): string | undefined {
  const fileName = path.basename(filePath, path.extname(filePath));

  if (fileName === "lib" || fileName === "main" || fileName === "mod") {
    return "crate";
  }

  return fileName === "" ? undefined : fileName;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
