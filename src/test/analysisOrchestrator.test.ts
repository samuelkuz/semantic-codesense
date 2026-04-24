import test from "node:test";
import assert from "node:assert/strict";

import { createAnalysisOrchestrator } from "../analysis/analysisOrchestrator";
import type { HypothesisGenerationResult, HypothesisGenerationService } from "../services/hypothesisGenerationService";
import type { AnalysisLoopRequest } from "../types/analysis";
import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { DraftHypothesis } from "../types/hypothesis";
import type { RankedEvidence, EvidenceRanker } from "../types/ranking";
import type { EvidenceRetriever, RetrievalAction, RetrievalPlanner } from "../types/retrieval";

test("analysis orchestrator stops immediately on high confidence", async () => {
  const hypothesisGenerator = new StubHypothesisGenerator([
    createDraft("draft-1", {
      confidence: "high"
    })
  ]);
  const planner = new StubRetrievalPlanner([]);
  const retriever = new StubEvidenceRetriever([]);
  const ranker = new StubEvidenceRanker();
  const orchestrator = createAnalysisOrchestrator(
    hypothesisGenerator,
    planner,
    retriever,
    ranker
  );

  const result = await orchestrator.analyze(createRequest());

  assert.equal(result.stopReason, "high_confidence");
  assert.equal(result.draftsByRound.length, 1);
  assert.deepEqual(result.executedActionsByRound, []);
  assert.equal(result.rankedEvidence[0]?.artifact.kind, "target_definition");
});

test("analysis orchestrator stops when retrieval yields no new evidence", async () => {
  const firstDraft = createDraft("draft-1", {
    confidence: "medium",
    unknowns: [
      {
        kind: "missing_helper_logic",
        question: "What does helper do?",
        targetSymbolName: "helper",
        priority: "high",
        evidenceArtifactIds: ["artifact-target"]
      }
    ]
  });
  const plannerActions: RetrievalAction[] = [
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    }
  ];
  const orchestrator = createAnalysisOrchestrator(
    new StubHypothesisGenerator([firstDraft]),
    new StubRetrievalPlanner([plannerActions]),
    new StubEvidenceRetriever([[]]),
    new StubEvidenceRanker()
  );

  const result = await orchestrator.analyze(createRequest());

  assert.equal(result.stopReason, "no_new_evidence");
  assert.deepEqual(result.executedActionsByRound, [plannerActions]);
  assert.equal(result.draftsByRound.length, 1);
  assert.equal(result.rounds[0]?.retrievedArtifacts.length, 0);
});

test("analysis orchestrator reruns hypothesis after successful retrieval and caps at two rounds", async () => {
  const draftRound0 = createDraft("draft-1", {
    confidence: "medium",
    unknowns: [
      {
        kind: "missing_helper_logic",
        question: "What does helper do?",
        targetSymbolName: "helper",
        priority: "high",
        evidenceArtifactIds: ["artifact-target"]
      }
    ]
  });
  const draftRound1 = createDraft("draft-2", {
    confidence: "medium",
    unknowns: [
      {
        kind: "missing_usage_context",
        question: "Where is this used?",
        priority: "medium",
        evidenceArtifactIds: ["artifact-helper"]
      }
    ]
  });
  const draftRound2 = createDraft("draft-3", {
    confidence: "medium",
    unknowns: []
  });
  const actionsRound1: RetrievalAction[] = [
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    }
  ];
  const actionsRound2: RetrievalAction[] = [
    {
      type: "fetch_call_sites",
      priority: "medium"
    }
  ];
  const helperArtifact = createArtifact("artifact-helper", "helper_definition", {
    retrievalRound: 1,
    retrievalActionType: "fetch_helper_definition"
  });
  const callSiteArtifact = createArtifact("artifact-call-site", "call_site", {
    retrievalRound: 2,
    retrievalActionType: "fetch_call_sites"
  });
  const orchestrator = createAnalysisOrchestrator(
    new StubHypothesisGenerator([draftRound0, draftRound1, draftRound2]),
    new StubRetrievalPlanner([actionsRound1, actionsRound2]),
    new StubEvidenceRetriever([[helperArtifact], [callSiteArtifact]]),
    new StubEvidenceRanker()
  );

  const result = await orchestrator.analyze(createRequest());

  assert.equal(result.stopReason, "max_rounds_reached");
  assert.equal(result.draftsByRound.length, 3);
  assert.deepEqual(result.executedActionsByRound, [actionsRound1, actionsRound2]);
  assert.equal(result.allEvidence.length, 3);
  assert.equal(result.finalDraft.evidenceSnapshotId, "draft-3");
  assert.equal(result.rounds.length, 2);
});

class StubHypothesisGenerator implements HypothesisGenerationService {
  private nextIndex = 0;

  constructor(private readonly drafts: DraftHypothesis[]) {}

  async generateDraft(): Promise<HypothesisGenerationResult> {
    const draft = this.drafts[this.nextIndex];

    if (!draft) {
      return {
        status: "error",
        message: "No more drafts configured."
      };
    }

    this.nextIndex += 1;

    return {
      status: "success",
      message: `Generated ${draft.evidenceSnapshotId}.`,
      draft
    };
  }
}

class StubRetrievalPlanner implements RetrievalPlanner {
  private nextIndex = 0;

  constructor(private readonly actionPlans: RetrievalAction[][]) {}

  plan(): RetrievalAction[] {
    const actions = this.actionPlans[this.nextIndex] ?? [];

    this.nextIndex += 1;

    return actions;
  }
}

class StubEvidenceRetriever implements EvidenceRetriever {
  private nextIndex = 0;

  constructor(private readonly retrievedArtifactsByRound: EvidenceArtifact[][]) {}

  async execute(): Promise<EvidenceArtifact[]> {
    const artifacts = this.retrievedArtifactsByRound[this.nextIndex] ?? [];

    this.nextIndex += 1;

    return artifacts;
  }
}

class StubEvidenceRanker implements EvidenceRanker {
  rank(
    ref: SymbolRef,
    evidence: EvidenceArtifact[]
  ): RankedEvidence[] {
    const targetDefinition = evidence.find((artifact) => artifact.kind === "target_definition");

    return evidence
      .map((artifact, index) => ({
        artifact,
        score: artifact.kind === "target_definition" ? 999 : 100 - index,
        rationale:
          artifact.kind === "target_definition"
            ? `Pinned target for ${ref.name}.`
            : `rank-${index}`
      }))
      .sort((left, right) => {
        if (left.artifact.id === targetDefinition?.id) {
          return -1;
        }

        if (right.artifact.id === targetDefinition?.id) {
          return 1;
        }

        return right.score - left.score;
      });
  }
}

function createRequest(): AnalysisLoopRequest {
  return {
    targetNode: {
      id: "rust:/tmp/example.rs:example:function:explain:1",
      filePath: "/tmp/example.rs",
      modulePath: "example",
      language: "rust",
      kind: "function",
      name: "explain",
      span: {
        startLine: 1,
        endLine: 1
      },
      signature: "fn explain()"
    },
    initialEvidence: [createArtifact("artifact-target", "target_definition")]
  };
}

function createDraft(
  evidenceSnapshotId: string,
  overrides: Partial<DraftHypothesis> = {}
): DraftHypothesis {
  return {
    evidenceSnapshotId,
    evidenceArtifactIds: ["artifact-target"],
    purpose: "Coordinate the example workflow.",
    keyBehavior: ["Delegates work to helper logic."],
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
  metadata: EvidenceArtifact["metadata"] = {}
): EvidenceArtifact {
  return {
    id,
    symbolId: "rust:/tmp/example.rs:example:function:explain:1",
    kind,
    title: id,
    content: id,
    metadata
  };
}
