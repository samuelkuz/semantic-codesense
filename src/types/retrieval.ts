import type { EvidenceArtifact } from "./evidence";
import type { SymbolRef } from "./graph";
import type { DraftHypothesis } from "./hypothesis";

export type RetrievalActionType =
  | "fetch_helper_definition"
  | "fetch_type_definition"
  | "fetch_call_sites"
  | "fetch_callers"
  | "fetch_trait_impls"
  | "fetch_field_usages";

export interface RetrievalAction {
  type: RetrievalActionType;
  targetName?: string;
  priority: "high" | "medium" | "low";
}

export interface RetrievalPlanner {
  plan(
    ref: SymbolRef,
    draft: DraftHypothesis,
    currentEvidence: EvidenceArtifact[]
  ): RetrievalAction[];
}

export interface EvidenceRetriever {
  execute(
    actions: RetrievalAction[],
    ref: SymbolRef
  ): Promise<EvidenceArtifact[]>;
}
