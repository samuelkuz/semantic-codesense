import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceRanker } from "../ranking/evidenceRanker";
import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { DraftHypothesis } from "../types/hypothesis";

test("evidence ranker always includes target definition and caps final budget", () => {
  const ranker = createEvidenceRanker();
  const evidence: EvidenceArtifact[] = [
    createArtifact("target", "target_definition", "target", "fn explain() {}"),
    createArtifact("doc", "doc_comment", "docs", "Explains the workflow."),
    createArtifact("module", "module_context", "module", "module context"),
    createArtifact("helper-1", "helper_definition", "helper one", "fn helper_one() {}"),
    createArtifact("helper-2", "helper_definition", "helper two", "fn helper_two() {}"),
    createArtifact("type-1", "type_definition", "ExampleState", "struct ExampleState { ... }"),
    createArtifact("type-2", "type_definition", "ExampleConfig", "struct ExampleConfig { ... }"),
    createArtifact("call-1", "call_site", "main", "main()"),
    createArtifact("call-2", "call_site", "worker", "worker()"),
    createArtifact("field-1", "field_access", "cache", "self.cache.insert(key, value)"),
    createArtifact("trait-1", "trait_impl", "Display impl", "impl Display for ExampleState { ... }"),
    createArtifact("caller-1", "caller", "test_explain", "test_explain()")
  ];

  const ranked = ranker.rank(createSymbolRef(), evidence, createDraftHypothesis());

  assert.equal(ranked.length, 8);
  assert.equal(ranked[0]?.artifact.kind, "target_definition");
  assert.ok(ranked.some((entry) => entry.artifact.id === "target"));
});

test("evidence ranker prioritizes high-priority unknown coverage", () => {
  const ranker = createEvidenceRanker();
  const ranked = ranker.rank(
    createSymbolRef(),
    [
      createArtifact("target", "target_definition", "target", "fn explain() {}"),
      createArtifact(
        "helper",
        "helper_definition",
        "helper",
        "fn helper() { state.cache.insert(key, value); }",
        {
          symbolName: "helper",
          nodeId: "helper-id",
          retrievalActionType: "fetch_helper_definition"
        }
      ),
      createArtifact(
        "caller",
        "caller",
        "main",
        "main() { explain(); }",
        {
          symbolName: "main"
        }
      )
    ],
    createDraftHypothesis({
      unknowns: [
        {
          kind: "missing_helper_logic",
          question: "What does helper do?",
          targetSymbolName: "helper",
          priority: "high",
          evidenceArtifactIds: ["helper"]
        }
      ]
    })
  );

  assert.equal(ranked[1]?.artifact.id, "helper");
  assert.match(ranked[1]?.rationale ?? "", /unknown-coverage/);
});

test("evidence ranker penalizes redundant artifacts and rewards denser snippets", () => {
  const ranker = createEvidenceRanker();
  const ranked = ranker.rank(
    createSymbolRef(),
    [
      createArtifact("target", "target_definition", "target", "fn explain() {}"),
      createArtifact(
        "field-dense",
        "field_access",
        "cache dense",
        "self.cache.insert(key, value)",
        {
          retrievalGroupKey: "cache"
        }
      ),
      createArtifact(
        "field-redundant-long",
        "field_access",
        "cache redundant long",
        Array.from({ length: 80 }, (_, index) => `cache usage line ${index + 1}`).join("\n"),
        {
          retrievalGroupKey: "cache"
        }
      )
    ],
    createDraftHypothesis({
      sideEffects: ["Mutates cache state."]
    })
  );

  const dense = ranked.find((entry) => entry.artifact.id === "field-dense");
  const redundant = ranked.find((entry) => entry.artifact.id === "field-redundant-long");

  assert.ok(dense && redundant);
  assert.ok(dense.score > redundant.score);
});

test("evidence ranker boosts likely important dependencies and purpose relevance", () => {
  const ranker = createEvidenceRanker();
  const helperId = "rust:/tmp/example.rs:example:function:helper:5";
  const ranked = ranker.rank(
    createSymbolRef(),
    [
      createArtifact("target", "target_definition", "target", "fn explain() {}"),
      createArtifact(
        "helper",
        "helper_definition",
        "helper",
        "fn helper() { persist_cache(); }",
        {
          nodeId: helperId,
          symbolName: "helper"
        }
      ),
      createArtifact(
        "module",
        "module_context",
        "module",
        "crate::example utilities",
        {
          symbolName: "example"
        }
      )
    ],
    createDraftHypothesis({
      purpose: "Persist cache state for the example workflow.",
      likelyImportantDependencies: [helperId]
    })
  );

  const helper = ranked.find((entry) => entry.artifact.id === "helper");
  const module = ranked.find((entry) => entry.artifact.id === "module");

  assert.ok(helper && module);
  assert.ok(helper.score > module.score);
  assert.match(helper.rationale, /direct-reference/);
  assert.match(helper.rationale, /purpose-side-effects|side-effect-proxy/);
});

function createSymbolRef(): SymbolRef {
  return {
    id: "rust:/tmp/example.rs:example:function:explain:1",
    name: "explain",
    kind: "function",
    filePath: "/tmp/example.rs",
    modulePath: "example",
    language: "rust"
  };
}

function createDraftHypothesis(
  overrides: Partial<DraftHypothesis> = {}
): DraftHypothesis {
  return {
    evidenceSnapshotId: "evidence-snapshot:abc",
    evidenceArtifactIds: ["target"],
    purpose: "Coordinate the example workflow.",
    keyBehavior: ["Delegates persistence to helper logic."],
    sideEffects: ["Mutates cache state."],
    confidence: "medium",
    unknowns: [],
    likelyImportantDependencies: [],
    ...overrides
  };
}

function createArtifact(
  id: string,
  kind: EvidenceArtifact["kind"],
  title: string,
  content: string,
  metadata: EvidenceArtifact["metadata"] = {}
): EvidenceArtifact {
  return {
    id,
    symbolId: createSymbolRef().id,
    kind,
    title,
    content,
    metadata: {
      symbolName: title,
      ...metadata
    }
  };
}
