import type { EvidenceArtifact } from "./evidence";
import type { SymbolRef } from "./graph";
import type { DraftHypothesis } from "./hypothesis";

export interface RankedEvidence {
  artifact: EvidenceArtifact;
  score: number;
  rationale: string;
}

export interface EvidenceRanker {
  rank(
    ref: SymbolRef,
    evidence: EvidenceArtifact[],
    draft: DraftHypothesis
  ): RankedEvidence[];
}
