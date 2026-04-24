import type { EvidenceArtifact } from "../types/evidence";
import type { EvidenceCollector } from "./evidenceCollector";
import { EvidenceRepository } from "./evidenceRepository";

interface EvidenceCollectionTarget {
  targetNode: {
    id: string;
  };
}

export class EvidenceOrchestrator<TInput extends EvidenceCollectionTarget> {
  constructor(
    private readonly collector: EvidenceCollector<TInput>,
    private readonly repository: EvidenceRepository
  ) {}

  async collectAndPersist(input: TInput): Promise<EvidenceArtifact[]> {
    const artifacts = await this.collector.collect(input);

    this.repository.saveArtifacts(artifacts);

    return this.repository.getArtifactsForSymbol(input.targetNode.id);
  }
}
