import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRustFileGraph,
  findInnermostSymbolAtLine,
  getSymbolContext
} from "../features/rust/rustGraphBuilder";

test("buildRustFileGraph models structs, impls, methods, and relationships", () => {
  const source = [
    "use crate::helpers::render_summary;",
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
    "    fn helper(&self) {}",
    "}"
  ].join("\n");

  const graph = buildRustFileGraph({
    filePath: "/repo/src/model.rs",
    sourceText: source
  });
  const explainMethod = graph.nodes.find(
    (node) => node.kind === "method" && node.name === "explain"
  );
  const helperMethod = graph.nodes.find(
    (node) => node.kind === "method" && node.name === "helper"
  );
  const mentalModelStruct = graph.nodes.find(
    (node) => node.kind === "struct" && node.name === "MentalModel"
  );
  const resultType = graph.nodes.find((node) => node.name === "Result");
  const implNode = graph.nodes.find((node) => node.kind === "impl");

  assert.ok(explainMethod);
  assert.ok(helperMethod);
  assert.ok(mentalModelStruct);
  assert.ok(resultType?.isExternal);
  assert.ok(implNode);

  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "calls" &&
        edge.from === explainMethod?.id &&
        edge.to === helperMethod?.id
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "uses_type" &&
        edge.from === explainMethod?.id &&
        edge.to === resultType?.id
    )
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "belongs_to" &&
        edge.from === helperMethod?.id &&
        edge.to === implNode?.id
    )
  );
});

test("getSymbolContext returns parent, callers, callees, and related types", () => {
  const source = [
    "pub struct MentalModel {}",
    "",
    "impl MentalModel {",
    "    pub fn explain(&self) -> Option<String> {",
    "        self.helper();",
    "        None",
    "    }",
    "",
    "    fn helper(&self) {}",
    "}",
    "",
    "fn caller(model: &MentalModel) {",
    "    model.explain();",
    "}"
  ].join("\n");

  const graph = buildRustFileGraph({
    filePath: "/repo/src/context.rs",
    sourceText: source
  });
  const explainMethod = graph.nodes.find(
    (node) => node.kind === "method" && node.name === "explain"
  );

  assert.ok(explainMethod);

  const context = getSymbolContext(graph, explainMethod.id);

  assert.ok(context);
  assert.equal(context.parent?.kind, "impl");
  assert.ok(context.callees.some((node) => node.name === "helper"));
  assert.ok(context.callers.some((node) => node.name === "caller"));
  assert.ok(context.relatedTypes.some((node) => node.name === "Option"));
});

test("findInnermostSymbolAtLine resolves the method at the cursor line", () => {
  const source = [
    "pub struct MentalModel {}",
    "",
    "impl MentalModel {",
    "    pub fn explain(&self) -> String {",
    "        self.helper()",
    "    }",
    "",
    "    fn helper(&self) -> String {",
    "        String::new()",
    "    }",
    "}"
  ].join("\n");

  const graph = buildRustFileGraph({
    filePath: "/repo/src/line_lookup.rs",
    sourceText: source
  });
  const symbol = findInnermostSymbolAtLine(graph, 5);

  assert.equal(symbol?.name, "explain");
  assert.equal(symbol?.kind, "method");
});
