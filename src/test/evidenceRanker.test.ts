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

test("evidence ranker boosts helper-linked trait impls and related custom types", () => {
  const ranker = createEvidenceRanker();
  const ranked = ranker.rank(
    createSymbolRef(),
    [
      createArtifact("target", "target_definition", "target", "fn build_review_digest() {}"),
      createArtifact(
        "helper",
        "helper_definition",
        "classify",
        "fn classify(&self, score: u8) -> ReviewDecision;",
        {
          symbolName: "classify"
        }
      ),
      createArtifact(
        "trait-impl",
        "trait_impl",
        "impl ReviewPlanner for WeightedReviewPlanner",
        "impl ReviewPlanner for WeightedReviewPlanner { fn classify(...) -> ReviewDecision { ... } }",
        {
          symbolName: "ReviewPlanner",
          relationship: "helper_trait_impl",
          sourceHelperName: "classify"
        }
      ),
      createArtifact(
        "related-type",
        "type_definition",
        "ReviewDecision",
        "pub struct ReviewDecision { risk_score: u8 }",
        {
          symbolName: "ReviewDecision",
          relationship: "helper_related_type",
          sourceHelperName: "classify"
        }
      )
    ],
    createDraftHypothesis({
      purpose: "Classify review risk and produce a ReviewDecision."
    })
  );

  const traitImpl = ranked.find((entry) => entry.artifact.id === "trait-impl");
  const relatedType = ranked.find((entry) => entry.artifact.id === "related-type");
  const helper = ranked.find((entry) => entry.artifact.id === "helper");

  assert.ok(traitImpl && relatedType && helper);
  assert.ok(traitImpl.score > helper.score);
  assert.ok(relatedType.score > helper.score);
  assert.match(traitImpl.rationale, /direct-reference/);
  assert.match(relatedType.rationale, /direct-reference/);
});

test("evidence ranker preserves likely dependency implementations under prompt budget", () => {
  const ranker = createEvidenceRanker();
  const classifyId = "rust:/tmp/review.rs:review:method:classify:27";
  const implId = "rust:/tmp/review.rs:review:impl:impl ReviewPlanner for WeightedReviewPlanner:103";
  const selectLaneId = "rust:/tmp/review.rs:review:function:select_review_lane:144";

  const ranked = ranker.rank(
    createSymbolRef(),
    [
      createArtifact("target", "target_definition", "build_review_digest", "fn build_review_digest() {}"),
      createArtifact("classify", "helper_definition", "classify", "fn classify(&self) -> ReviewDecision;", {
        nodeId: classifyId,
        symbolName: "classify"
      }),
      createArtifact(
        "select-lane",
        "helper_definition",
        "select_review_lane",
        "pub fn select_review_lane(decision: &ReviewDecision, profile: &OpsProfile) -> String { \"senior-ops\".to_string() }",
        {
          nodeId: selectLaneId,
          symbolName: "select_review_lane"
        }
      ),
      createArtifact(
        "trait-impl",
        "trait_impl",
        "impl ReviewPlanner for WeightedReviewPlanner",
        "impl ReviewPlanner for WeightedReviewPlanner { fn classify(&self) -> ReviewDecision { ReviewDecision { risk_score: 80 } } }",
        {
          nodeId: implId,
          symbolName: "impl ReviewPlanner for WeightedReviewPlanner",
          relationship: "helper_trait_impl",
          sourceHelperName: "classify"
        }
      ),
      createArtifact("review-decision-1", "type_definition", "ReviewDecision", "pub struct ReviewDecision { risk_score: u8 }", {
        nodeId: "rust:/tmp/review.rs:review:struct:ReviewDecision:4",
        relationship: "helper_related_type",
        sourceHelperName: "classify"
      }),
      createArtifact("review-decision-2", "type_definition", "ReviewDecision", "pub struct ReviewDecision { risk_score: u8 }", {
        nodeId: "rust:/tmp/review.rs:review:struct:ReviewDecision:4",
        relationship: "helper_related_type",
        sourceHelperName: "select_review_lane"
      }),
      createArtifact("ops-profile-1", "type_definition", "OpsProfile", "pub struct OpsProfile { fallback_lane: String }", {
        nodeId: "rust:/tmp/review.rs:review:struct:OpsProfile:20",
        relationship: "helper_related_type",
        sourceHelperName: "select_review_lane"
      }),
      createArtifact("order", "type_definition", "Order", "pub struct Order { id: String }", {
        nodeId: "rust:/tmp/domain.rs:domain:struct:Order:45"
      }),
      createArtifact("warehouse", "type_definition", "Warehouse", "pub struct Warehouse { inventory: HashMap<String, u32> }", {
        nodeId: "rust:/tmp/domain.rs:domain:struct:Warehouse:102"
      }),
      createArtifact("trait", "type_definition", "ReviewPlanner", "pub trait ReviewPlanner { fn classify(&self) -> ReviewDecision; }", {
        nodeId: "rust:/tmp/review.rs:review:trait:ReviewPlanner:26"
      }),
      createArtifact("call-site", "call_site", "test", "assert!(digest.contains(\"lane=senior-ops\"));"),
      createArtifact("doc", "doc_comment", "docs", "Multi-hop symbol.")
    ],
    createDraftHypothesis({
      confidence: "high",
      likelyImportantDependencies: [
        classifyId,
        implId,
        selectLaneId,
        "rust:/tmp/review.rs:review:struct:ReviewDecision:4",
        "rust:/tmp/review.rs:review:struct:OpsProfile:20",
        "rust:/tmp/domain.rs:domain:struct:Order:45",
        "rust:/tmp/domain.rs:domain:struct:Warehouse:102",
        "rust:/tmp/review.rs:review:trait:ReviewPlanner:26"
      ]
    })
  );

  const rankedIds = ranked.map((entry) => entry.artifact.id);

  assert.ok(rankedIds.includes("classify"));
  assert.ok(rankedIds.includes("select-lane"));
  assert.ok(rankedIds.includes("trait-impl"));
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
