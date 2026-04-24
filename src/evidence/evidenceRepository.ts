import type { EvidenceArtifact, EvidenceStore } from "../types/evidence";

export class EvidenceRepository {
  constructor(private readonly store: EvidenceStore) {}

  saveArtifacts(artifacts: EvidenceArtifact[]): void {
    this.store.addArtifacts(artifacts);
  }

  getArtifactsForSymbol(symbolId: string): EvidenceArtifact[] {
    return this.store.getArtifactsForSymbol(symbolId);
  }

  getArtifactById(id: string): EvidenceArtifact | undefined {
    return this.store.getArtifactById(id);
  }
}
