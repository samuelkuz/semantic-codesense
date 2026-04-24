import type { EvidenceArtifact } from "./evidence";
import type { SymbolRef, SymbolNode } from "./graph";
import type { DraftHypothesis } from "./hypothesis";
import type { RankedEvidence } from "./ranking";
import type { RetrievalAction } from "./retrieval";

export type AnalysisStopReason =
  | "high_confidence"
  | "no_actions"
  | "no_new_evidence"
  | "max_rounds_reached";

export interface AnalysisLoopRequest {
  targetNode: SymbolNode;
  initialEvidence: EvidenceArtifact[];
}

export interface AnalysisRoundResult {
  round: number;
  draft: DraftHypothesis;
  plannedActions: RetrievalAction[];
  retrievedArtifacts: EvidenceArtifact[];
}

export interface AnalysisLoopResult {
  ref: SymbolRef;
  finalDraft: DraftHypothesis;
  rankedEvidence: RankedEvidence[];
  allEvidence: EvidenceArtifact[];
  executedActionsByRound: RetrievalAction[][];
  draftsByRound: DraftHypothesis[];
  rounds: AnalysisRoundResult[];
  stopReason: AnalysisStopReason;
}
