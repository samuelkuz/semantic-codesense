import test from "node:test";
import assert from "node:assert/strict";

import { resolveNodeToFullLocalSpan } from "../features/rust/rustLocalSymbolResolver";
import {
  findBestLocalSymbolNode,
  findTraitImplNodesForMethod,
  getHelperRelatedTypeNames
} from "../features/rust/rustEvidenceRetriever";
import { buildRustFileGraph } from "../features/rust/rustGraphBuilder";

test("findBestLocalSymbolNode recovers full struct span from shallow resolved symbol metadata", () => {
  const sourceText = [
    "#[derive(Clone, Debug)]",
    "pub struct Order {",
    "    pub id: String,",
    "    pub status: OrderStatus,",
    "    pub flagged_for_review: bool,",
    "}",
    "",
    "impl Order {",
    "    pub fn new(id: impl Into<String>) -> Self {",
    "        Self {",
    "            id: id.into(),",
    "            status: OrderStatus::PendingPayment,",
    "            flagged_for_review: false,",
    "        }",
    "    }",
    "}",
    "",
    "pub enum OrderStatus {",
    "    PendingPayment,",
    "}"
  ].join("\n");

  const matchedNode = findBestLocalSymbolNode(
    {
      id: "rust:workspace-symbol:file:///tmp/domain.rs:Order:2",
      name: "Order",
      kind: "struct",
      filePath: "/tmp/domain.rs",
      modulePath: "crate::domain",
      startLine: 2,
      endLine: 2,
      resolvedBy: "workspace_symbol"
    },
    sourceText
  );

  assert.ok(matchedNode);
  assert.equal(matchedNode.kind, "struct");
  assert.equal(matchedNode.name, "Order");
  assert.equal(matchedNode.span.startLine, 2);
  assert.equal(matchedNode.span.endLine, 6);
});

test("resolveNodeToFullLocalSpan expands shallow local nodes before snippet extraction", () => {
  const sourceText = [
    "#[derive(Clone, Debug)]",
    "pub struct Order {",
    "    pub id: String,",
    "    pub status: OrderStatus,",
    "    pub flagged_for_review: bool,",
    "}",
    "",
    "pub enum OrderStatus {",
    "    PendingPayment,",
    "}"
  ].join("\n");

  const resolvedNode = resolveNodeToFullLocalSpan(
    {
      id: "rust:workspace-symbol:file:///tmp/domain.rs:Order:2",
      name: "Order",
      kind: "struct",
      filePath: "/tmp/domain.rs",
      modulePath: "crate::domain",
      span: {
        startLine: 2,
        endLine: 2
      },
      language: "rust"
    },
    sourceText
  );

  assert.equal(resolvedNode.span.startLine, 2);
  assert.equal(resolvedNode.span.endLine, 6);
});

test("findTraitImplNodesForMethod locates concrete impls for trait helper methods", () => {
  const sourceText = [
    "pub struct ReviewDecision {",
    "    pub risk_score: u8,",
    "}",
    "",
    "pub trait ReviewPlanner {",
    "    fn classify(&self, score: u8) -> ReviewDecision;",
    "}",
    "",
    "pub struct WeightedReviewPlanner;",
    "",
    "impl ReviewPlanner for WeightedReviewPlanner {",
    "    fn classify(&self, score: u8) -> ReviewDecision {",
    "        ReviewDecision { risk_score: score }",
    "    }",
    "}"
  ].join("\n");
  const graph = buildRustFileGraph({
    filePath: "/tmp/review.rs",
    sourceText
  });

  const implNodes = findTraitImplNodesForMethod(
    graph,
    "ReviewPlanner",
    "classify"
  );

  assert.equal(implNodes.length, 1);
  assert.equal(implNodes[0]?.name, "impl ReviewPlanner for WeightedReviewPlanner");
});

test("getHelperRelatedTypeNames includes custom helper types and excludes standard library containers", () => {
  const sourceText = [
    "pub struct ReviewDecision {",
    "    pub risk_score: u8,",
    "}",
    "",
    "pub fn select_review_lane(decision: ReviewDecision, notes: Vec<String>) -> ReviewDecision {",
    "    decision",
    "}"
  ].join("\n");
  const graph = buildRustFileGraph({
    filePath: "/tmp/review.rs",
    sourceText
  });
  const helperNode = graph.nodes.find(
    (node) => node.kind === "function" && node.name === "select_review_lane"
  );

  assert.ok(helperNode);
  assert.deepEqual(getHelperRelatedTypeNames(graph, helperNode), [
    "ReviewDecision"
  ]);
});
