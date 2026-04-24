import test from "node:test";
import assert from "node:assert/strict";

import { createRetrievalPlanner } from "../retrieval/retrievalPlanner";
import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { DraftHypothesis } from "../types/hypothesis";

test("retrieval planner stops early on high confidence", () => {
  const planner = createRetrievalPlanner();
  const actions = planner.plan(createSymbolRef(), {
    evidenceSnapshotId: "evidence-snapshot:abc",
    evidenceArtifactIds: ["artifact-1"],
    purpose: "Handles the main workflow.",
    keyBehavior: ["Delegates to helper functions."],
    sideEffects: [],
    confidence: "high",
    unknowns: [
      {
        kind: "missing_helper_logic",
        question: "What does helper do?",
        targetSymbolName: "helper",
        priority: "high",
        evidenceArtifactIds: ["artifact-1"]
      }
    ],
    likelyImportantDependencies: []
  }, [
    createArtifact("artifact-1", "target_definition", "explain", "explain")
  ]);

  assert.deepEqual(actions, []);
});

test("retrieval planner maps unknowns into bounded deduped actions", () => {
  const planner = createRetrievalPlanner();
  const actions = planner.plan(
    createSymbolRef(),
    createDraftHypothesis({
      confidence: "medium",
      unknowns: [
        {
          kind: "missing_helper_logic",
          question: "What does helper do?",
          targetSymbolName: "helper",
          priority: "high",
          evidenceArtifactIds: ["artifact-1"]
        },
        {
          kind: "missing_type_semantics",
          question: "What does ExampleState represent?",
          targetSymbolName: "ExampleState",
          priority: "medium",
          evidenceArtifactIds: ["artifact-1"]
        },
        {
          kind: "missing_usage_context",
          question: "Who calls this symbol?",
          priority: "medium",
          evidenceArtifactIds: ["artifact-1"]
        },
        {
          kind: "missing_usage_context",
          question: "Who else calls this symbol?",
          priority: "low",
          evidenceArtifactIds: ["artifact-1"]
        }
      ]
    }),
    [
      createArtifact("artifact-1", "target_definition", "explain", "explain")
    ]
  );

  assert.deepEqual(actions, [
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    },
    {
      type: "fetch_type_definition",
      targetName: "ExampleState",
      priority: "medium"
    },
    {
      type: "fetch_call_sites",
      priority: "medium"
    }
  ]);
});

test("retrieval planner avoids requests already satisfied by evidence", () => {
  const planner = createRetrievalPlanner();
  const actions = planner.plan(
    createSymbolRef(),
    createDraftHypothesis({
      unknowns: [
        {
          kind: "missing_helper_logic",
          question: "What does helper do?",
          targetSymbolName: "helper",
          priority: "high",
          evidenceArtifactIds: ["artifact-target"]
        },
        {
          kind: "missing_usage_context",
          question: "Where is this called?",
          priority: "medium",
          evidenceArtifactIds: ["artifact-target"]
        },
        {
          kind: "missing_field_role",
          question: "How is cache used?",
          targetSymbolName: "cache",
          priority: "medium",
          evidenceArtifactIds: ["artifact-target"]
        }
      ]
    }),
    [
      createArtifact("artifact-target", "target_definition", "explain", "explain"),
      createArtifact("artifact-helper", "helper_definition", "helper", "helper", {
        retrievalActionType: "fetch_helper_definition"
      }),
      createArtifact("artifact-call-site", "call_site", "call site", "explain"),
      createArtifact("artifact-field", "field_access", "cache", "cache")
    ]
  );

  assert.deepEqual(actions, [
    {
      type: "fetch_callers",
      priority: "medium"
    }
  ]);
});

test("retrieval planner still fetches helper details when only initial collector snippets exist", () => {
  const planner = createRetrievalPlanner();
  const actions = planner.plan(
    createSymbolRef(),
    createDraftHypothesis({
      unknowns: [
        {
          kind: "missing_helper_logic",
          question: "What does classify do?",
          targetSymbolName: "classify",
          priority: "high",
          evidenceArtifactIds: ["artifact-target"]
        }
      ]
    }),
    [
      createArtifact("artifact-target", "target_definition", "explain", "explain"),
      createArtifact("artifact-helper", "helper_definition", "classify", "classify")
    ]
  );

  assert.deepEqual(actions, [
    {
      type: "fetch_helper_definition",
      targetName: "classify",
      priority: "high"
    }
  ]);
});

test("retrieval planner stops after two retrieval rounds", () => {
  const planner = createRetrievalPlanner();
  const actions = planner.plan(
    createSymbolRef(),
    createDraftHypothesis({
      unknowns: [
        {
          kind: "missing_helper_logic",
          question: "What does helper do?",
          targetSymbolName: "helper",
          priority: "high",
          evidenceArtifactIds: ["artifact-target"]
        }
      ]
    }),
    [
      createArtifact("artifact-target", "target_definition", "explain", "explain"),
      createArtifact("artifact-round-1", "helper_definition", "helper", "helper", {
        retrievalRound: 1
      }),
      createArtifact("artifact-round-2", "type_definition", "ExampleState", "ExampleState", {
        retrievalRound: 2
      })
    ]
  );

  assert.deepEqual(actions, []);
});

test("retrieval planner derives target names from evidence-linked dependencies", () => {
  const planner = createRetrievalPlanner();
  const helperId = "rust:/tmp/example.rs:example:function:helper:5";
  const actions = planner.plan(
    createSymbolRef(),
    createDraftHypothesis({
      likelyImportantDependencies: [helperId],
      unknowns: [
        {
          kind: "missing_side_effect_evidence",
          question: "Could helper mutate state?",
          priority: "high",
          evidenceArtifactIds: ["artifact-helper"]
        }
      ]
    }),
    [
      createArtifact("artifact-target", "target_definition", "explain", "explain"),
      {
        id: "artifact-helper",
        symbolId: "rust:/tmp/example.rs:example:function:explain:1",
        kind: "callee",
        title: "function `helper`",
        content: "helper()",
        metadata: {
          nodeId: helperId,
          symbolName: "helper"
        }
      }
    ]
  );

  assert.deepEqual(actions, [
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    }
  ]);
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
  overrides: Partial<DraftHypothesis>
): DraftHypothesis {
  return {
    evidenceSnapshotId: "evidence-snapshot:abc",
    evidenceArtifactIds: ["artifact-target"],
    purpose: "Coordinates the example flow.",
    keyBehavior: ["Delegates work to helpers."],
    sideEffects: [],
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
  symbolName: string,
  metadata: EvidenceArtifact["metadata"] = {}
): EvidenceArtifact {
  return {
    id,
    symbolId: "rust:/tmp/example.rs:example:function:explain:1",
    kind,
    title,
    content: title,
    metadata: {
      symbolName,
      ...metadata
    }
  };
}
