import type {
  AnalysisLoopRequest,
  AnalysisLoopResult,
  AnalysisRoundResult,
  AnalysisStopReason
} from "../types/analysis";
import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { RetrievalAction, RetrievalPlanner, EvidenceRetriever } from "../types/retrieval";
import type {
  HypothesisGenerationRequest,
  HypothesisGenerationService
} from "../services/hypothesisGenerationService";
import type { EvidenceRanker } from "../types/ranking";
import type { DraftHypothesis } from "../types/hypothesis";

const MAX_ANALYSIS_ROUNDS = 2;

export interface AnalysisOrchestrator {
  analyze(request: AnalysisLoopRequest): Promise<AnalysisLoopResult>;
}

export class DefaultAnalysisOrchestrator implements AnalysisOrchestrator {
  constructor(
    private readonly hypothesisGenerator: HypothesisGenerationService,
    private readonly retrievalPlanner: RetrievalPlanner,
    private readonly evidenceRetriever: EvidenceRetriever,
    private readonly evidenceRanker: EvidenceRanker
  ) {}

  async analyze(request: AnalysisLoopRequest): Promise<AnalysisLoopResult> {
    const ref = createSymbolRef(request);
    const allEvidence = [...request.initialEvidence];
    const draftsByRound: DraftHypothesis[] = [];
    const executedActionsByRound: RetrievalAction[][] = [];
    const rounds: AnalysisRoundResult[] = [];

    let currentDraft = await generateDraftOrThrow(
      this.hypothesisGenerator,
      request.targetNode,
      allEvidence
    );
    draftsByRound.push(currentDraft);

    let stopReason: AnalysisStopReason | undefined;

    for (let round = 1; round <= MAX_ANALYSIS_ROUNDS; round += 1) {
      if (currentDraft.confidence === "high") {
        stopReason = "high_confidence";
        break;
      }

      const plannedActions = this.retrievalPlanner.plan(
        ref,
        currentDraft,
        allEvidence
      );
      executedActionsByRound.push(plannedActions);

      if (plannedActions.length === 0) {
        rounds.push({
          round,
          draft: currentDraft,
          plannedActions,
          retrievedArtifacts: []
        });
        stopReason = "no_actions";
        break;
      }

      const retrievedArtifacts = await this.evidenceRetriever.execute(
        plannedActions,
        ref
      );

      rounds.push({
        round,
        draft: currentDraft,
        plannedActions,
        retrievedArtifacts
      });

      if (retrievedArtifacts.length === 0) {
        stopReason = "no_new_evidence";
        break;
      }

      allEvidence.push(...retrievedArtifacts);
      currentDraft = await generateDraftOrThrow(
        this.hypothesisGenerator,
        request.targetNode,
        allEvidence
      );
      draftsByRound.push(currentDraft);
    }

    const resolvedStopReason =
      stopReason ??
      (currentDraft.confidence === "high" ? "high_confidence" : "max_rounds_reached");
    const rankedEvidence = this.evidenceRanker.rank(
      ref,
      allEvidence,
      currentDraft
    );

    return {
      ref,
      finalDraft: currentDraft,
      rankedEvidence,
      allEvidence,
      executedActionsByRound,
      draftsByRound,
      rounds,
      stopReason: resolvedStopReason
    };
  }
}

export function createAnalysisOrchestrator(
  hypothesisGenerator: HypothesisGenerationService,
  retrievalPlanner: RetrievalPlanner,
  evidenceRetriever: EvidenceRetriever,
  evidenceRanker: EvidenceRanker
): AnalysisOrchestrator {
  return new DefaultAnalysisOrchestrator(
    hypothesisGenerator,
    retrievalPlanner,
    evidenceRetriever,
    evidenceRanker
  );
}

async function generateDraftOrThrow(
  hypothesisGenerator: HypothesisGenerationService,
  targetNode: HypothesisGenerationRequest["targetNode"],
  evidenceArtifacts: EvidenceArtifact[]
): Promise<DraftHypothesis> {
  const result = await hypothesisGenerator.generateDraft({
    targetNode,
    evidenceArtifacts
  });

  if (result.status !== "success" || !result.draft) {
    throw new Error(result.message);
  }

  return result.draft;
}

function createSymbolRef(request: AnalysisLoopRequest): SymbolRef {
  return {
    id: request.targetNode.id,
    name: request.targetNode.name,
    kind: request.targetNode.kind,
    filePath: request.targetNode.filePath,
    modulePath: request.targetNode.modulePath,
    language: request.targetNode.language
  };
}
