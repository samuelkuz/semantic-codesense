import { createHash } from "node:crypto";

import type { EvidenceArtifact } from "./evidence";

export type HypothesisConfidence = "high" | "medium" | "low";

export type UnknownKind =
  | "missing_type_semantics"
  | "missing_helper_logic"
  | "missing_usage_context"
  | "missing_side_effect_evidence"
  | "missing_trait_behavior"
  | "missing_field_role";

export type UnknownPriority = "high" | "medium" | "low";

export interface UnknownQuestion {
  kind: UnknownKind;
  question: string;
  targetSymbolName?: string;
  priority: UnknownPriority;
  evidenceArtifactIds: string[];
}

export interface DraftHypothesis {
  evidenceSnapshotId: string;
  evidenceArtifactIds: string[];
  purpose?: string;
  keyBehavior: string[];
  sideEffects: string[];
  confidence: HypothesisConfidence;
  unknowns: UnknownQuestion[];
  likelyImportantDependencies: string[];
}

export interface EvidenceSnapshot {
  evidenceSnapshotId: string;
  evidenceArtifactIds: string[];
}

export function createEvidenceSnapshot(
  evidenceArtifacts: EvidenceArtifact[]
): EvidenceSnapshot {
  const evidenceArtifactIds = [...new Set(
    evidenceArtifacts.map((artifact) => artifact.id)
  )].sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256")
    .update(evidenceArtifactIds.join("\n"))
    .digest("hex")
    .slice(0, 16);

  return {
    evidenceSnapshotId: `evidence-snapshot:${hash}`,
    evidenceArtifactIds
  };
}
