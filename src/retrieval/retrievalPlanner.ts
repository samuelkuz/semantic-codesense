import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type {
  DraftHypothesis,
  UnknownPriority,
  UnknownQuestion
} from "../types/hypothesis";
import type {
  RetrievalAction,
  RetrievalActionType,
  RetrievalPlanner
} from "../types/retrieval";

const MAX_ACTIONS_PER_ROUND = 3;
const MAX_RETRIEVAL_ROUNDS = 2;

const PRIORITY_ORDER: Record<UnknownPriority, number> = {
  high: 0,
  medium: 1,
  low: 2
};

export class DeterministicRetrievalPlanner implements RetrievalPlanner {
  plan(
    ref: SymbolRef,
    draft: DraftHypothesis,
    currentEvidence: EvidenceArtifact[]
  ): RetrievalAction[] {
    if (
      draft.confidence === "high" ||
      draft.unknowns.length === 0 ||
      getCompletedRetrievalRounds(currentEvidence) >= MAX_RETRIEVAL_ROUNDS
    ) {
      return [];
    }

    const evidenceById = new Map(
      currentEvidence.map((artifact) => [artifact.id, artifact] as const)
    );
    const dependencyNameById = buildDependencyNameById(currentEvidence);
    const actions: RetrievalAction[] = [];
    const plannedKeys = new Set<string>();

    draft.unknowns
      .slice()
      .sort(compareUnknowns)
      .forEach((unknown) => {
        for (const candidate of mapUnknownToActions(
          ref,
          draft,
          unknown,
          evidenceById,
          dependencyNameById
        )) {
          if (actions.length >= MAX_ACTIONS_PER_ROUND) {
            return;
          }

          const key = createActionKey(candidate);

          if (plannedKeys.has(key) || hasEquivalentEvidence(candidate, currentEvidence)) {
            continue;
          }

          plannedKeys.add(key);
          actions.push(candidate);
        }
      });

    return actions.slice(0, MAX_ACTIONS_PER_ROUND);
  }
}

export function createRetrievalPlanner(): RetrievalPlanner {
  return new DeterministicRetrievalPlanner();
}

function mapUnknownToActions(
  ref: SymbolRef,
  draft: DraftHypothesis,
  unknown: UnknownQuestion,
  evidenceById: Map<string, EvidenceArtifact>,
  dependencyNameById: Map<string, string>
): RetrievalAction[] {
  const targetName = resolveTargetName(
    ref,
    draft,
    unknown,
    evidenceById,
    dependencyNameById
  );

  switch (unknown.kind) {
    case "missing_helper_logic":
      return [
        createAction("fetch_helper_definition", unknown.priority, targetName)
      ];
    case "missing_type_semantics":
      return [
        createAction("fetch_type_definition", unknown.priority, targetName)
      ];
    case "missing_usage_context":
      return [
        createAction("fetch_call_sites", unknown.priority),
        createAction("fetch_callers", unknown.priority)
      ];
    case "missing_trait_behavior":
      return [
        createAction("fetch_trait_impls", unknown.priority, targetName)
      ];
    case "missing_field_role":
      return [
        createAction("fetch_field_usages", unknown.priority, targetName)
      ];
    case "missing_side_effect_evidence":
      return targetName
        ? [createAction("fetch_helper_definition", unknown.priority, targetName)]
        : [createAction("fetch_call_sites", unknown.priority)];
    default:
      return [];
  }
}

function createAction(
  type: RetrievalActionType,
  priority: UnknownPriority,
  targetName?: string
): RetrievalAction {
  return targetName
    ? {
        type,
        targetName,
        priority
      }
    : {
        type,
        priority
      };
}

function resolveTargetName(
  ref: SymbolRef,
  draft: DraftHypothesis,
  unknown: UnknownQuestion,
  evidenceById: Map<string, EvidenceArtifact>,
  dependencyNameById: Map<string, string>
): string | undefined {
  if (unknown.targetSymbolName?.trim()) {
    return unknown.targetSymbolName.trim();
  }

  for (const artifactId of unknown.evidenceArtifactIds) {
    const artifact = evidenceById.get(artifactId);
    const artifactSymbolName = artifact?.metadata?.symbolName;

    if (
      typeof artifactSymbolName === "string" &&
      artifactSymbolName.length > 0 &&
      artifactSymbolName !== ref.name
    ) {
      return artifactSymbolName;
    }
  }

  for (const dependencyId of draft.likelyImportantDependencies) {
    const dependencyName = dependencyNameById.get(dependencyId);

    if (dependencyName && dependencyName !== ref.name) {
      return dependencyName;
    }
  }

  return undefined;
}

function buildDependencyNameById(
  currentEvidence: EvidenceArtifact[]
): Map<string, string> {
  const result = new Map<string, string>();

  for (const artifact of currentEvidence) {
    const nodeId = artifact.metadata?.nodeId;
    const symbolName = artifact.metadata?.symbolName;

    if (
      typeof nodeId === "string" &&
      nodeId.length > 0 &&
      typeof symbolName === "string" &&
      symbolName.length > 0 &&
      !result.has(nodeId)
    ) {
      result.set(nodeId, symbolName);
    }
  }

  return result;
}

function hasEquivalentEvidence(
  action: RetrievalAction,
  currentEvidence: EvidenceArtifact[]
): boolean {
  switch (action.type) {
    case "fetch_helper_definition":
      return hasRetrievedHelperEvidenceForTarget(currentEvidence, action.targetName);
    case "fetch_type_definition":
      return hasArtifactForTarget(currentEvidence, "type_definition", action.targetName);
    case "fetch_call_sites":
      return currentEvidence.some((artifact) => artifact.kind === "call_site");
    case "fetch_callers":
      return currentEvidence.some((artifact) => artifact.kind === "caller");
    case "fetch_trait_impls":
      return hasArtifactForTarget(currentEvidence, "trait_impl", action.targetName);
    case "fetch_field_usages":
      return hasArtifactForTarget(currentEvidence, "field_access", action.targetName);
    default:
      return false;
  }
}

function hasRetrievedHelperEvidenceForTarget(
  currentEvidence: EvidenceArtifact[],
  targetName?: string
): boolean {
  const normalizedTargetName = normalizeName(targetName);

  return currentEvidence.some((artifact) => {
    if (artifact.kind !== "helper_definition") {
      return false;
    }

    const retrievalActionType = normalizeName(artifact.metadata?.retrievalActionType);

    if (retrievalActionType !== "fetch_helper_definition") {
      return false;
    }

    if (!normalizedTargetName) {
      return true;
    }

    const artifactSymbolName = normalizeName(artifact.metadata?.symbolName);

    if (artifactSymbolName === normalizedTargetName) {
      return true;
    }

    return normalizeName(artifact.title).includes(normalizedTargetName);
  });
}

function hasArtifactForTarget(
  currentEvidence: EvidenceArtifact[],
  artifactKind: EvidenceArtifact["kind"],
  targetName?: string
): boolean {
  const normalizedTargetName = normalizeName(targetName);

  return currentEvidence.some((artifact) => {
    if (artifact.kind !== artifactKind) {
      return false;
    }

    if (!normalizedTargetName) {
      return true;
    }

    const artifactSymbolName = normalizeName(artifact.metadata?.symbolName);

    if (artifactSymbolName === normalizedTargetName) {
      return true;
    }

    return normalizeName(artifact.title).includes(normalizedTargetName);
  });
}

function getCompletedRetrievalRounds(
  currentEvidence: EvidenceArtifact[]
): number {
  let maxRound = 0;

  for (const artifact of currentEvidence) {
    const retrievalRound = artifact.metadata?.retrievalRound;

    if (typeof retrievalRound === "number" && retrievalRound > maxRound) {
      maxRound = retrievalRound;
    }
  }

  return maxRound;
}

function compareUnknowns(
  left: UnknownQuestion,
  right: UnknownQuestion
): number {
  const priorityDelta = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.question.localeCompare(right.question);
}

function createActionKey(action: RetrievalAction): string {
  return `${action.type}:${normalizeName(action.targetName)}`;
}

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
