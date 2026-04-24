import type { EvidenceArtifact } from "../types/evidence";

export interface EvidenceCollector<TInput> {
  collect(input: TInput): Promise<EvidenceArtifact[]>;
}
