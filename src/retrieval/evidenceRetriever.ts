import type { EvidenceRepository } from "../evidence/evidenceRepository";
import type { EvidenceArtifact, EvidenceKind, EvidenceMetadata } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type {
  EvidenceRetriever,
  RetrievalAction,
  RetrievalActionType
} from "../types/retrieval";

export type RetrievalSource = "tree_sitter" | "rust_analyzer" | "hybrid";

export interface RetrievedArtifactCandidate {
  kind: EvidenceKind;
  title: string;
  content: string;
  metadata?: EvidenceMetadata;
  retrievedBy: RetrievalSource;
  groupKey?: string;
}

export interface RetrievalExecutionContext {
  ref: SymbolRef;
  action: RetrievalAction;
  currentEvidence: EvidenceArtifact[];
  maxArtifacts: number;
}

export interface EvidenceRetrievalBackend {
  retrieve(
    context: RetrievalExecutionContext
  ): Promise<RetrievedArtifactCandidate[]>;
}

interface BudgetRule {
  kind: EvidenceKind;
  max: number;
  countMode: "artifacts" | "groups";
}

const BUDGETS: Record<RetrievalActionType, BudgetRule> = {
  fetch_helper_definition: {
    kind: "helper_definition",
    max: 3,
    countMode: "artifacts"
  },
  fetch_type_definition: {
    kind: "type_definition",
    max: 2,
    countMode: "artifacts"
  },
  fetch_call_sites: {
    kind: "call_site",
    max: 2,
    countMode: "artifacts"
  },
  fetch_callers: {
    kind: "caller",
    max: 2,
    countMode: "artifacts"
  },
  fetch_trait_impls: {
    kind: "trait_impl",
    max: 1,
    countMode: "groups"
  },
  fetch_field_usages: {
    kind: "field_access",
    max: 2,
    countMode: "groups"
  }
};

const MAX_RETRIEVAL_ROUNDS = 2;

export class BudgetedEvidenceRetriever implements EvidenceRetriever {
  constructor(
    private readonly repository: EvidenceRepository,
    private readonly backend: EvidenceRetrievalBackend
  ) {}

  async execute(
    actions: RetrievalAction[],
    ref: SymbolRef
  ): Promise<EvidenceArtifact[]> {
    const existingEvidence = this.repository.getArtifactsForSymbol(ref.id);
    const nextRound = getNextRetrievalRound(existingEvidence);

    if (nextRound > MAX_RETRIEVAL_ROUNDS) {
      return [];
    }

    const dedupedActions = dedupeActions(actions);
    const collectedArtifacts: EvidenceArtifact[] = [];
    const seenArtifactKeys = new Set(
      existingEvidence.map((artifact) => createArtifactIdentityKey(artifact))
    );

    for (const action of dedupedActions) {
      const remainingBudget = getRemainingBudget(
        action,
        existingEvidence,
        collectedArtifacts
      );

      if (remainingBudget <= 0) {
        continue;
      }

      try {
        const candidateArtifacts = await this.backend.retrieve({
          ref,
          action,
          currentEvidence: [...existingEvidence, ...collectedArtifacts],
          maxArtifacts: remainingBudget
        });

        for (const candidate of candidateArtifacts) {
          if (getRemainingBudget(action, existingEvidence, collectedArtifacts) <= 0) {
            break;
          }

          const artifact = createRetrievedArtifact(
            ref,
            action,
            candidate,
            nextRound,
            collectedArtifacts.length
          );
          const identityKey = createArtifactIdentityKey(artifact);

          if (seenArtifactKeys.has(identityKey)) {
            continue;
          }

          seenArtifactKeys.add(identityKey);
          collectedArtifacts.push(artifact);
        }
      } catch {
        continue;
      }
    }

    if (collectedArtifacts.length > 0) {
      this.repository.saveArtifacts(collectedArtifacts);
    }

    return collectedArtifacts;
  }
}

function dedupeActions(actions: RetrievalAction[]): RetrievalAction[] {
  const uniqueActions = new Map<string, RetrievalAction>();

  for (const action of actions) {
    const key = `${action.type}:${normalizeName(action.targetName)}`;

    if (!uniqueActions.has(key)) {
      uniqueActions.set(key, action);
    }
  }

  return [...uniqueActions.values()];
}

function getNextRetrievalRound(currentEvidence: EvidenceArtifact[]): number {
  let maxRound = 0;

  for (const artifact of currentEvidence) {
    const retrievalRound = artifact.metadata?.retrievalRound;

    if (typeof retrievalRound === "number") {
      maxRound = Math.max(maxRound, retrievalRound);
    }
  }

  return maxRound + 1;
}

function getRemainingBudget(
  action: RetrievalAction,
  currentEvidence: EvidenceArtifact[],
  pendingArtifacts: EvidenceArtifact[]
): number {
  const rule = BUDGETS[action.type];
  const matchingArtifacts = [...currentEvidence, ...pendingArtifacts].filter(
    (artifact) => artifact.kind === rule.kind
  );

  if (rule.countMode === "artifacts") {
    return Math.max(rule.max - matchingArtifacts.length, 0);
  }

  const consumedGroups = new Set(
    matchingArtifacts.map((artifact) => getArtifactGroupKey(artifact))
  );

  return Math.max(rule.max - consumedGroups.size, 0);
}

function getArtifactGroupKey(artifact: EvidenceArtifact): string {
  const retrievalGroupKey = artifact.metadata?.retrievalGroupKey;

  if (typeof retrievalGroupKey === "string" && retrievalGroupKey.length > 0) {
    return retrievalGroupKey;
  }

  const symbolName = artifact.metadata?.symbolName;

  if (typeof symbolName === "string" && symbolName.length > 0) {
    return symbolName.toLowerCase();
  }

  return artifact.title.toLowerCase();
}

function createRetrievedArtifact(
  ref: SymbolRef,
  action: RetrievalAction,
  candidate: RetrievedArtifactCandidate,
  retrievalRound: number,
  sequence: number
): EvidenceArtifact {
  const metadata: EvidenceMetadata = {
    ...(candidate.metadata ?? {}),
    renderAsCode: true,
    retrievedBy: candidate.retrievedBy,
    retrievalRound,
    retrievalActionType: action.type
  };

  if (action.targetName) {
    metadata.retrievalTargetName = action.targetName;
  }

  if (candidate.groupKey) {
    metadata.retrievalGroupKey = candidate.groupKey;
  }

  return {
    id: createRetrievedArtifactId(ref.id, action, candidate, sequence),
    symbolId: ref.id,
    kind: candidate.kind,
    title: candidate.title,
    content: candidate.content,
    metadata
  };
}

function createRetrievedArtifactId(
  symbolId: string,
  action: RetrievalAction,
  candidate: RetrievedArtifactCandidate,
  sequence: number
): string {
  const filePath = normalizeName(candidate.metadata?.filePath);
  const startLine = candidate.metadata?.startLine;

  return [
    symbolId,
    action.type,
    slugify(candidate.title),
    filePath,
    typeof startLine === "number" ? String(startLine) : String(sequence)
  ]
    .filter((part) => part.length > 0)
    .join(":");
}

function createArtifactIdentityKey(artifact: EvidenceArtifact): string {
  return [
    artifact.kind,
    normalizeName(artifact.metadata?.filePath),
    String(artifact.metadata?.startLine ?? ""),
    normalizeName(artifact.metadata?.symbolName),
    slugify(artifact.title)
  ].join(":");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
