export interface EvidenceStore {
  addArtifacts(artifacts: EvidenceArtifact[]): void;
  getArtifactsForSymbol(symbolId: string): EvidenceArtifact[];
  getArtifactById(id: string): EvidenceArtifact | undefined;
}

export type EvidenceKind =
  | "target_definition"
  | "helper_definition"
  | "caller"
  | "callee"
  | "call_site"
  | "type_definition"
  | "trait_impl"
  | "field_access"
  | "module_context"
  | "doc_comment";

export type EvidenceMetadata = Record<string, string | number | boolean>;

export interface EvidenceArtifact {
  id: string;
  symbolId: string;
  kind: EvidenceKind;
  title: string;
  content: string;
  metadata?: EvidenceMetadata;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly artifactsById = new Map<string, EvidenceArtifact>();
  private readonly artifactIdsBySymbol = new Map<string, string[]>();

  addArtifacts(artifacts: EvidenceArtifact[]): void {
    for (const artifact of artifacts) {
      const existing = this.artifactsById.get(artifact.id);

      this.artifactsById.set(artifact.id, artifact);

      if (existing?.symbolId === artifact.symbolId) {
        continue;
      }

      if (existing) {
        const existingIds = this.artifactIdsBySymbol.get(existing.symbolId) ?? [];
        this.artifactIdsBySymbol.set(
          existing.symbolId,
          existingIds.filter((artifactId) => artifactId !== artifact.id)
        );
      }

      const symbolArtifactIds = this.artifactIdsBySymbol.get(artifact.symbolId) ?? [];

      if (!symbolArtifactIds.includes(artifact.id)) {
        symbolArtifactIds.push(artifact.id);
        this.artifactIdsBySymbol.set(artifact.symbolId, symbolArtifactIds);
      }
    }
  }

  getArtifactsForSymbol(symbolId: string): EvidenceArtifact[] {
    const artifactIds = this.artifactIdsBySymbol.get(symbolId) ?? [];

    return artifactIds
      .map((artifactId) => this.artifactsById.get(artifactId))
      .filter((artifact): artifact is EvidenceArtifact => artifact !== undefined);
  }

  getArtifactById(id: string): EvidenceArtifact | undefined {
    return this.artifactsById.get(id);
  }
}
