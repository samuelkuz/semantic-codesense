import test from "node:test";
import assert from "node:assert/strict";

import { parseRustSyntaxFile } from "../features/rust/rustTreeSitterParser";

test("parseRustSyntaxFile extracts Rust symbols from syntax tree nodes", () => {
  const source = [
    "pub struct MentalModel {",
    "    summary: String,",
    "}",
    "",
    "pub enum State {",
    "    Ready,",
    "}",
    "",
    "pub trait Explain {",
    "    fn explain(&self);",
    "}",
    "",
    "impl MentalModel {",
    "    pub fn explain(&self) -> Result<String, Error> {",
    "        self.helper();",
    "        helper()",
    "    }",
    "",
    "    fn helper(&self) {}",
    "}",
    "",
    "mod nested {",
    "    fn inside() {}",
    "}"
  ].join("\n");

  const syntax = parseRustSyntaxFile({
    filePath: "/repo/src/model.rs",
    sourceText: source
  });

  assert.deepEqual(
    syntax.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`),
    [
      "struct:MentalModel",
      "enum:State",
      "trait:Explain",
      "method:explain",
      "impl:impl MentalModel",
      "method:explain",
      "method:helper",
      "module:nested",
      "function:inside"
    ]
  );
});

test("parseRustSyntaxFile extracts imports, calls, and type references", () => {
  const source = [
    "use crate::helpers::{render_summary, TypeAlias};",
    "",
    "pub struct MentalModel {",
    "    summary: String,",
    "}",
    "",
    "impl MentalModel {",
    "    pub fn explain(&self) -> Result<String, Error> {",
    "        self.helper();",
    "        render_summary(self)",
    "    }",
    "",
    "    fn helper(&self) -> TypeAlias {",
    "        todo!()",
    "    }",
    "}"
  ].join("\n");

  const syntax = parseRustSyntaxFile({
    filePath: "/repo/src/model.rs",
    sourceText: source
  });
  const explainMethod = syntax.symbols.find(
    (symbol) => symbol.kind === "method" && symbol.name === "explain"
  );
  const helperMethod = syntax.symbols.find(
    (symbol) => symbol.kind === "method" && symbol.name === "helper"
  );

  assert.ok(explainMethod);
  assert.ok(helperMethod);
  assert.deepEqual(syntax.importBindings[0]?.importedNames, [
    "render_summary",
    "TypeAlias"
  ]);
  assert.ok(
    syntax.callBindings.some(
      (binding) =>
        binding.ownerSymbolId === explainMethod.id &&
        binding.targetKindHint === "method" &&
        binding.targetName === "helper"
    )
  );
  assert.ok(
    syntax.callBindings.some(
      (binding) =>
        binding.ownerSymbolId === explainMethod.id &&
        binding.targetKindHint === "function" &&
        binding.targetName === "render_summary"
    )
  );
  assert.ok(
    syntax.typeBindings.some(
      (binding) =>
        binding.ownerSymbolId === explainMethod.id &&
        binding.typeName === "Result"
    )
  );
  assert.ok(
    syntax.typeBindings.some(
      (binding) =>
        binding.ownerSymbolId === helperMethod.id &&
        binding.typeName === "TypeAlias"
    )
  );
});
