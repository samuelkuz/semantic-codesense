import type { EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { DraftHypothesis, UnknownPriority, UnknownQuestion } from "../types/hypothesis";
import type { EvidenceRanker, RankedEvidence } from "../types/ranking";

const TARGET_ARTIFACT_COUNT = 8;
const MAX_ARTIFACT_COUNT = 12;

const UNKNOWN_PRIORITY_SCORES: Record<UnknownPriority, number> = {
  high: 28,
  medium: 16,
  low: 8
};

const KIND_BASE_SCORES: Record<EvidenceArtifact["kind"], number> = {
  target_definition: 120,
  helper_definition: 34,
  callee: 20,
  type_definition: 30,
  trait_impl: 28,
  field_access: 26,
  call_site: 22,
  caller: 18,
  doc_comment: 12,
  module_context: 10
};

export class DeterministicEvidenceRanker implements EvidenceRanker {
  rank(
    ref: SymbolRef,
    evidence: EvidenceArtifact[],
    draft: DraftHypothesis
  ): RankedEvidence[] {
    if (evidence.length === 0) {
      return [];
    }

    const redundancyCounts = countRedundancyBuckets(evidence);
    const scoredEvidence = evidence.map((artifact) =>
      scoreArtifact(ref, artifact, draft, redundancyCounts)
    );
    const targetDefinition = scoredEvidence.find(
      (entry) => entry.artifact.kind === "target_definition"
    );
    const remaining = scoredEvidence
      .filter((entry) => entry.artifact.kind !== "target_definition")
      .sort(compareRankedEvidence);
    const requiredDependencies = selectRequiredDependencyEvidence(
      remaining,
      draft
    ).slice(0, MAX_ARTIFACT_COUNT - (targetDefinition ? 1 : 0));
    const requiredArtifactIds = new Set(
      requiredDependencies.map((entry) => entry.artifact.id)
    );
    const fillCandidates = remaining.filter(
      (entry) => !requiredArtifactIds.has(entry.artifact.id)
    );
    const budget = Math.min(
      Math.min(evidence.length, MAX_ARTIFACT_COUNT),
      Math.max(
        TARGET_ARTIFACT_COUNT,
        (targetDefinition ? 1 : 0) + requiredDependencies.length
      )
    );
    const rankedResults = targetDefinition
      ? [
          targetDefinition,
          ...requiredDependencies,
          ...fillCandidates.slice(
            0,
            Math.max(budget - 1 - requiredDependencies.length, 0)
          )
        ]
      : [
          ...requiredDependencies,
          ...fillCandidates.slice(
            0,
            Math.max(budget - requiredDependencies.length, 0)
          )
        ];

    return rankedResults.sort(compareRankedEvidence);
  }
}

export function createEvidenceRanker(): EvidenceRanker {
  return new DeterministicEvidenceRanker();
}

function scoreArtifact(
  ref: SymbolRef,
  artifact: EvidenceArtifact,
  draft: DraftHypothesis,
  redundancyCounts: Map<string, number>
): RankedEvidence {
  let score = KIND_BASE_SCORES[artifact.kind];
  const rationaleParts: string[] = [`base=${KIND_BASE_SCORES[artifact.kind]} (${artifact.kind})`];

  if (artifact.kind === "target_definition") {
    score += 500;
    rationaleParts.push("always include target definition");
  }

  const directReferenceScore = scoreDirectReference(ref, artifact, draft);

  if (directReferenceScore > 0) {
    score += directReferenceScore;
    rationaleParts.push(`direct-reference=+${directReferenceScore}`);
  }

  const unknownScore = scoreUnknownCoverage(artifact, draft.unknowns);

  if (unknownScore.score > 0) {
    score += unknownScore.score;
    rationaleParts.push(`unknown-coverage=+${unknownScore.score} (${unknownScore.matches.join(", ")})`);
  }

  const intentScore = scorePurposeAndSideEffectRelevance(artifact, draft);

  if (intentScore.score !== 0) {
    score += intentScore.score;
    rationaleParts.push(`${intentScore.label}=${intentScore.score > 0 ? "+" : ""}${intentScore.score}`);
  }

  const densityScore = scoreInformationDensity(artifact);

  score += densityScore;
  rationaleParts.push(`density=${densityScore > 0 ? "+" : ""}${densityScore}`);

  const redundancyPenalty = scoreRedundancyPenalty(artifact, redundancyCounts);

  if (redundancyPenalty !== 0) {
    score += redundancyPenalty;
    rationaleParts.push(`redundancy=${redundancyPenalty}`);
  }

  return {
    artifact,
    score,
    rationale: rationaleParts.join("; ")
  };
}

function selectRequiredDependencyEvidence(
  rankedEvidence: RankedEvidence[],
  draft: DraftHypothesis
): RankedEvidence[] {
  if (draft.likelyImportantDependencies.length === 0) {
    return [];
  }

  const dependencyIds = new Set(draft.likelyImportantDependencies);
  const selectedByDependencyId = new Map<string, RankedEvidence>();

  for (const entry of rankedEvidence) {
    const nodeId = getMetadataString(entry.artifact, "nodeId");

    if (!nodeId || !dependencyIds.has(nodeId)) {
      continue;
    }

    const existing = selectedByDependencyId.get(nodeId);

    if (!existing || compareRankedEvidence(entry, existing) < 0) {
      selectedByDependencyId.set(nodeId, entry);
    }
  }

  return [...selectedByDependencyId.values()].sort(compareRankedEvidence);
}

function scoreDirectReference(
  ref: SymbolRef,
  artifact: EvidenceArtifact,
  draft: DraftHypothesis
): number {
  if (artifact.kind === "target_definition") {
    return 0;
  }

  const nodeId = getMetadataString(artifact, "nodeId");
  const retrievalActionType = getMetadataString(artifact, "retrievalActionType");
  const symbolKind = getMetadataString(artifact, "symbolKind");
  const relationship = getMetadataString(artifact, "relationship");

  if (nodeId && draft.likelyImportantDependencies.includes(nodeId)) {
    return 26;
  }

  if (
    relationship === "helper_related_type" ||
    relationship === "helper_trait_impl"
  ) {
    return 24;
  }

  if (
    retrievalActionType === "fetch_helper_definition" ||
    retrievalActionType === "fetch_type_definition" ||
    retrievalActionType === "fetch_trait_impls"
  ) {
    return 18;
  }

  if (
    getMetadataString(artifact, "retrievalTargetName") === ref.name ||
    getMetadataString(artifact, "symbolName") === ref.name
  ) {
    return 12;
  }

  if (symbolKind === "method" || symbolKind === "function" || symbolKind === "trait") {
    return 8;
  }

  return 0;
}

function scoreUnknownCoverage(
  artifact: EvidenceArtifact,
  unknowns: UnknownQuestion[]
): {
  score: number;
  matches: string[];
} {
  let score = 0;
  const matches: string[] = [];

  for (const unknown of unknowns) {
    const matched =
      unknown.evidenceArtifactIds.includes(artifact.id) ||
      matchesUnknownTarget(artifact, unknown);

    if (!matched) {
      continue;
    }

    const increment = UNKNOWN_PRIORITY_SCORES[unknown.priority];

    score += increment;
    matches.push(`${unknown.kind}:${unknown.priority}`);
  }

  return {
    score,
    matches
  };
}

function scorePurposeAndSideEffectRelevance(
  artifact: EvidenceArtifact,
  draft: DraftHypothesis
): {
  score: number;
  label: string;
} {
  const artifactText = normalizeText([
    artifact.title,
    artifact.content,
    getMetadataString(artifact, "symbolName"),
    getMetadataString(artifact, "retrievalTargetName")
  ].filter((value): value is string => value !== undefined).join(" "));
  const purposeTokens = tokenize(draft.purpose ?? "");
  const behaviorTokens = tokenize(draft.keyBehavior.join(" "));
  const sideEffectTokens = tokenize(draft.sideEffects.join(" "));
  const relevanceTokens = new Set([
    ...purposeTokens,
    ...behaviorTokens,
    ...sideEffectTokens
  ]);

  let overlapCount = 0;

  for (const token of relevanceTokens) {
    if (artifactText.includes(token)) {
      overlapCount += 1;
    }
  }

  if (overlapCount > 0) {
    return {
      score: Math.min(overlapCount * 5, 20),
      label: "purpose-side-effects"
    };
  }

  if (
    draft.sideEffects.length > 0 &&
    (artifact.kind === "field_access" ||
      artifact.kind === "helper_definition" ||
      artifact.kind === "trait_impl")
  ) {
    return {
      score: 8,
      label: "side-effect-proxy"
    };
  }

  return {
    score: 0,
    label: "purpose-side-effects"
  };
}

function scoreInformationDensity(artifact: EvidenceArtifact): number {
  const contentLength = artifact.content.trim().length;
  const lineCount = artifact.content.split("\n").length;

  if (contentLength === 0) {
    return -8;
  }

  if (contentLength <= 220 && lineCount <= 12) {
    return 12;
  }

  if (contentLength <= 480 && lineCount <= 24) {
    return 6;
  }

  if (contentLength >= 1200 || lineCount >= 60) {
    return -10;
  }

  return 0;
}

function scoreRedundancyPenalty(
  artifact: EvidenceArtifact,
  redundancyCounts: Map<string, number>
): number {
  if (artifact.kind === "target_definition") {
    return 0;
  }

  const bucketCount = redundancyCounts.get(getRedundancyKey(artifact)) ?? 1;

  if (bucketCount <= 1) {
    return 0;
  }

  return -6 * (bucketCount - 1);
}

function compareRankedEvidence(left: RankedEvidence, right: RankedEvidence): number {
  if (left.artifact.kind === "target_definition" && right.artifact.kind !== "target_definition") {
    return -1;
  }

  if (right.artifact.kind === "target_definition" && left.artifact.kind !== "target_definition") {
    return 1;
  }

  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.artifact.id.localeCompare(right.artifact.id);
}

function countRedundancyBuckets(
  evidence: EvidenceArtifact[]
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const artifact of evidence) {
    const key = getRedundancyKey(artifact);

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function getRedundancyKey(artifact: EvidenceArtifact): string {
  const groupKey =
    getMetadataString(artifact, "retrievalGroupKey") ??
    getMetadataString(artifact, "nodeId") ??
    getMetadataString(artifact, "symbolName") ??
    artifact.title;

  return `${artifact.kind}:${groupKey.toLowerCase()}`;
}

function matchesUnknownTarget(
  artifact: EvidenceArtifact,
  unknown: UnknownQuestion
): boolean {
  const unknownTarget = unknown.targetSymbolName?.trim().toLowerCase();

  if (!unknownTarget) {
    return false;
  }

  const artifactTargets = [
    artifact.title,
    getMetadataString(artifact, "symbolName"),
    getMetadataString(artifact, "retrievalTargetName")
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toLowerCase());

  return artifactTargets.some((value) => value.includes(unknownTarget));
}

function getMetadataString(
  artifact: EvidenceArtifact,
  key: string
): string | undefined {
  const value = artifact.metadata?.[key];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}
