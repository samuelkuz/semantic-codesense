import type { Logger } from "../core/logger";
import type { EvidenceArtifact } from "../types/evidence";
import {
  createEvidenceSnapshot,
  type DraftHypothesis,
  type HypothesisConfidence,
  type UnknownKind,
  type UnknownPriority,
  type UnknownQuestion
} from "../types/hypothesis";
import type { SymbolNode } from "../types/graph";

export interface HypothesisGenerationRequest {
  targetNode: SymbolNode;
  evidenceArtifacts: EvidenceArtifact[];
}

export interface HypothesisGenerationResult {
  status: "success" | "error";
  message: string;
  draft?: DraftHypothesis;
  rawResponse?: string;
  prompt?: string;
}

export interface HypothesisGenerationService {
  generateDraft(
    request: HypothesisGenerationRequest
  ): Promise<HypothesisGenerationResult>;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

interface DraftHypothesisCandidate {
  purpose?: unknown;
  keyBehavior?: unknown;
  sideEffects?: unknown;
  confidence?: unknown;
  unknowns?: unknown;
  likelyImportantDependencies?: unknown;
}

interface UnknownQuestionCandidate {
  kind?: unknown;
  question?: unknown;
  targetSymbolName?: unknown;
  priority?: unknown;
  evidenceArtifactIds?: unknown;
}

interface ValidationResult<T> {
  value?: T;
  reason?: string;
  warnings?: string[];
}

type FetchLike = typeof fetch;

export interface HypothesisGenerationServiceOptions {
  ollamaBaseUrl: string;
  ollamaModel: string;
}

const HYPOTHESIS_CONFIDENCE_LEVELS = new Set<HypothesisConfidence>([
  "high",
  "medium",
  "low"
]);
const UNKNOWN_KINDS = new Set<UnknownKind>([
  "missing_type_semantics",
  "missing_helper_logic",
  "missing_usage_context",
  "missing_side_effect_evidence",
  "missing_trait_behavior",
  "missing_field_role"
]);
const UNKNOWN_PRIORITIES = new Set<UnknownPriority>(["high", "medium", "low"]);
const DRAFT_HYPOTHESIS_KEYS = new Set<keyof DraftHypothesisCandidate>([
  "purpose",
  "keyBehavior",
  "sideEffects",
  "confidence",
  "unknowns",
  "likelyImportantDependencies"
]);
const UNKNOWN_QUESTION_KEYS = new Set<keyof UnknownQuestionCandidate>([
  "kind",
  "question",
  "targetSymbolName",
  "priority",
  "evidenceArtifactIds"
]);

const BASE_PROMPT = `You are the hypothesis generator for a Rust code understanding pipeline.

Your job:
1. Produce a structured draft hypothesis for the target symbol.
2. Summarize only from the evidence provided.
3. Explicitly state uncertainty.
4. Do not guess hidden behavior.
5. Produce unknowns only when more evidence would materially improve the answer.

Rules:
- Use only the supplied evidence artifacts.
- Treat missing evidence as unknown, not proof.
- If the evidence is too weak to support a purpose statement, omit the purpose field.
- likelyImportantDependencies must contain stable symbol IDs, not display names.
- Copy dependency IDs exactly from the provided candidate list; do not rewrite, shorten, normalize, or invent IDs.
- Each unknown must cite the evidence artifact IDs that exposed the gap.
- Return only valid JSON that matches the requested schema exactly.`;

class OllamaHypothesisGenerationService
  implements HypothesisGenerationService
{
  constructor(
    private readonly logger: Logger,
    private readonly options: HypothesisGenerationServiceOptions,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async generateDraft(
    request: HypothesisGenerationRequest
  ): Promise<HypothesisGenerationResult> {
    const { ollamaBaseUrl, ollamaModel } = this.options;
    const evidenceSnapshot = createEvidenceSnapshot(request.evidenceArtifacts);
    const dependencyCandidates = collectDependencyCandidates(
      request.targetNode,
      request.evidenceArtifacts
    );
    const prompt = buildPrompt(
      request,
      evidenceSnapshot.evidenceSnapshotId,
      dependencyCandidates
    );
    const endpoint = `${ollamaBaseUrl}/api/generate`;

    this.logger.info(
      `Generating draft hypothesis for ${request.targetNode.kind} "${request.targetNode.name}" via Ollama model "${ollamaModel}".`
    );
    this.logger.info(
      `Ollama request: POST ${endpoint} (model=${ollamaModel}, promptChars=${prompt.length})`
    );

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          prompt
        })
      });

      this.logger.info(
        `Ollama response: HTTP ${response.status} ${response.statusText || ""}`.trim()
      );

      if (!response.ok) {
        this.logger.error(
          `Ollama request failed for draft hypothesis of ${request.targetNode.name}: HTTP ${response.status} ${response.statusText || ""}`.trim()
        );
        return {
          status: "error",
          message: `Ollama request failed with HTTP ${response.status}.`,
          prompt
        };
      }

      const payload = (await response.json()) as OllamaGenerateResponse;
      const rawResponse = payload.response?.trim();

      this.logger.debug(
        `Ollama response body preview: ${truncateForLog(rawResponse ?? payload.error ?? "<empty>", 3000)}`
      );

      if (!rawResponse) {
        this.logger.error(
          `Ollama returned no generated content for draft hypothesis of ${request.targetNode.name}: ${payload.error ?? "empty response body"}`
        );
        return {
          status: "error",
          message: payload.error || "Ollama returned an empty response.",
          prompt
        };
      }

      const candidate = parseDraftHypothesisCandidate(rawResponse);

      if (!candidate) {
        this.logger.error(
          `Ollama returned non-JSON draft hypothesis content for ${request.targetNode.name}. Preview: ${truncateForLog(rawResponse, 600)}`
        );
        return {
          status: "error",
          message: "Ollama returned a draft hypothesis that could not be parsed as JSON.",
          rawResponse,
          prompt
        };
      }

      const validation = validateDraftHypothesisCandidate(
        candidate,
        evidenceSnapshot,
        dependencyCandidates.map((candidateEntry) => candidateEntry.id)
      );

      if (!validation.value) {
        this.logger.debug(
          `Draft hypothesis validation failed for ${request.targetNode.name}: ${validation.reason ?? "unknown validation error"}`
        );
        this.logger.debug(
          `Draft hypothesis validation context for ${request.targetNode.name}: evidenceSnapshotId=${evidenceSnapshot.evidenceSnapshotId}, artifactIds=${evidenceSnapshot.evidenceArtifactIds.join(", ") || "<none>"}, validDependencyIds=${dependencyCandidates.map((candidateEntry) => candidateEntry.id).join(", ") || "<none>"}`
        );
        this.logger.debug(
          `Draft hypothesis candidate keys for ${request.targetNode.name}: ${Object.keys(candidate).sort().join(", ") || "<none>"}`
        );
        this.logger.error(
          `Ollama returned an invalid draft hypothesis shape for ${request.targetNode.name}. Reason: ${validation.reason ?? "unknown validation error"}. Preview: ${truncateForLog(rawResponse, 600)}`
        );
        return {
          status: "error",
          message: "Ollama returned a draft hypothesis that did not match the required schema.",
          rawResponse,
          prompt
        };
      }

      for (const warning of validation.warnings ?? []) {
        this.logger.warn(
          `Draft hypothesis validation warning for ${request.targetNode.name}: ${warning}`
        );
      }

      return {
        status: "success",
        message: `Generated draft hypothesis for ${request.targetNode.kind} "${request.targetNode.name}".`,
        draft: validation.value,
        rawResponse,
        prompt
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Ollama request failure.";
      this.logger.error(
        `Failed to generate draft hypothesis for ${request.targetNode.name} via ${endpoint}: ${message}`
      );

      return {
        status: "error",
        message: `Failed to reach Ollama at ${ollamaBaseUrl}: ${message}`,
        prompt
      };
    }
  }
}

export function createHypothesisGenerationService(
  logger: Logger,
  options: HypothesisGenerationServiceOptions,
  fetchImpl?: FetchLike
): HypothesisGenerationService {
  return new OllamaHypothesisGenerationService(logger, options, fetchImpl);
}

function buildPrompt(
  request: HypothesisGenerationRequest,
  evidenceSnapshotId: string,
  dependencyCandidates: DependencyCandidate[]
): string {
  const schema = `{
  "purpose": "...",
  "keyBehavior": ["...", "..."],
  "sideEffects": ["...", "..."],
  "confidence": "high",
  "unknowns": [
    {
      "kind": "missing_helper_logic",
      "question": "...",
      "targetSymbolName": "...",
      "priority": "high",
      "evidenceArtifactIds": ["artifact-id-1"]
    }
  ],
  "likelyImportantDependencies": ["rust:/path/to/file.rs:module:function:helper:42"]
}`;

  return [
    BASE_PROMPT,
    "",
    "Return only valid JSON with this shape:",
    schema,
    "",
    `Evidence snapshot ID: ${evidenceSnapshotId}`,
    `Target symbol: ${request.targetNode.kind} ${request.targetNode.name} (${request.targetNode.id})`,
    "",
    "Valid unknown kinds:",
    "- missing_type_semantics",
    "- missing_helper_logic",
    "- missing_usage_context",
    "- missing_side_effect_evidence",
    "- missing_trait_behavior",
    "- missing_field_role",
    "",
    dependencyCandidates.length > 0
      ? [
          "Known symbol IDs you may reference in likelyImportantDependencies:",
          ...dependencyCandidates.map(
            (candidate) => `- ${candidate.id}: ${candidate.label}`
          )
        ].join("\n")
      : "Known symbol IDs you may reference in likelyImportantDependencies:\n- none provided; return an empty array if no stable IDs are available.",
    "",
    "Collected evidence artifacts:",
    formatEvidenceArtifactsForPrompt(request.evidenceArtifacts)
  ].join("\n");
}

function parseDraftHypothesisCandidate(
  rawResponse: string
): DraftHypothesisCandidate | undefined {
  const fencedJson = rawResponse.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedJson?.[1] ?? rawResponse;

  try {
    const parsed = JSON.parse(candidate) as unknown;

    if (!isRecord(parsed) || !hasOnlyKnownKeys(parsed, DRAFT_HYPOTHESIS_KEYS)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

function validateDraftHypothesisCandidate(
  candidate: DraftHypothesisCandidate,
  evidenceSnapshot: {
    evidenceSnapshotId: string;
    evidenceArtifactIds: string[];
  },
  validDependencyIds: string[]
): ValidationResult<DraftHypothesis> {
  if (
    candidate.purpose !== undefined &&
    (typeof candidate.purpose !== "string" || candidate.purpose.trim().length === 0)
  ) {
    return {
      reason: "purpose must be omitted or a non-empty string"
    };
  }

  const keyBehavior = parseStringArray(candidate.keyBehavior);
  const sideEffects = parseStringArray(candidate.sideEffects);
  const likelyImportantDependencies = parseStringArray(
    candidate.likelyImportantDependencies
  );

  if (
    keyBehavior === undefined ||
    sideEffects === undefined ||
    likelyImportantDependencies === undefined
  ) {
    return {
      reason:
        "keyBehavior, sideEffects, and likelyImportantDependencies must all be arrays of strings"
    };
  }

  if (
    typeof candidate.confidence !== "string" ||
    !HYPOTHESIS_CONFIDENCE_LEVELS.has(candidate.confidence as HypothesisConfidence)
  ) {
    return {
      reason: `confidence must be one of: ${[...HYPOTHESIS_CONFIDENCE_LEVELS].join(", ")}`
    };
  }

  if (!Array.isArray(candidate.unknowns)) {
    return {
      reason: "unknowns must be an array"
    };
  }

  const evidenceArtifactIds = new Set(evidenceSnapshot.evidenceArtifactIds);
  const dependencyIds = new Set(validDependencyIds);
  const unknowns: UnknownQuestion[] = [];

  for (const item of candidate.unknowns) {
    if (
      !isRecord(item) ||
      !hasOnlyKnownKeys(item, UNKNOWN_QUESTION_KEYS)
    ) {
      return {
        reason:
          "each unknown must be an object containing only kind, question, targetSymbolName, priority, and evidenceArtifactIds"
      };
    }

    const unknown = item as UnknownQuestionCandidate;

    if (
      typeof unknown.kind !== "string" ||
      !UNKNOWN_KINDS.has(unknown.kind as UnknownKind) ||
      typeof unknown.question !== "string" ||
      unknown.question.trim().length === 0 ||
      typeof unknown.priority !== "string" ||
      !UNKNOWN_PRIORITIES.has(unknown.priority as UnknownPriority)
    ) {
      return {
        reason:
          "each unknown must include a valid kind, a non-empty question, and a priority of high, medium, or low"
      };
    }

    if (
      unknown.targetSymbolName !== undefined &&
      (typeof unknown.targetSymbolName !== "string" ||
        unknown.targetSymbolName.trim().length === 0)
    ) {
      return {
        reason: "targetSymbolName must be omitted or a non-empty string"
      };
    }

    const unknownEvidenceArtifactIds = parseStringArray(
      unknown.evidenceArtifactIds
    );

    if (
      unknownEvidenceArtifactIds === undefined ||
      unknownEvidenceArtifactIds.length === 0 ||
      unknownEvidenceArtifactIds.some(
        (artifactId) => !evidenceArtifactIds.has(artifactId)
      )
    ) {
      return {
        reason:
          "each unknown must cite one or more valid evidenceArtifactIds from the current evidence snapshot"
      };
    }

    unknowns.push({
      kind: unknown.kind as UnknownKind,
      question: unknown.question.trim(),
      targetSymbolName:
        typeof unknown.targetSymbolName === "string"
          ? unknown.targetSymbolName.trim()
          : undefined,
      priority: unknown.priority as UnknownPriority,
      evidenceArtifactIds: dedupeAndSortStrings(unknownEvidenceArtifactIds)
    });
  }

  if (
    likelyImportantDependencies.some(
      (dependencyId) => !dependencyIds.has(dependencyId)
    )
  ) {
    const invalidDependencyIds = likelyImportantDependencies.filter(
      (dependencyId) => !dependencyIds.has(dependencyId)
    );
    const filteredDependencies = likelyImportantDependencies.filter(
      (dependencyId) => dependencyIds.has(dependencyId)
    );

    return {
      value: {
        evidenceSnapshotId: evidenceSnapshot.evidenceSnapshotId,
        evidenceArtifactIds: evidenceSnapshot.evidenceArtifactIds,
        purpose:
          typeof candidate.purpose === "string" ? candidate.purpose.trim() : undefined,
        keyBehavior,
        sideEffects,
        confidence: candidate.confidence as HypothesisConfidence,
        unknowns,
        likelyImportantDependencies: dedupeAndSortStrings(filteredDependencies)
      },
      warnings: [
        `Dropped invalid likelyImportantDependencies not present in the current dependency candidate list: ${dedupeAndSortStrings(invalidDependencyIds).join(", ")}`
      ]
    };
  }

  return {
    value: {
      evidenceSnapshotId: evidenceSnapshot.evidenceSnapshotId,
      evidenceArtifactIds: evidenceSnapshot.evidenceArtifactIds,
      purpose:
        typeof candidate.purpose === "string" ? candidate.purpose.trim() : undefined,
      keyBehavior,
      sideEffects,
      confidence: candidate.confidence as HypothesisConfidence,
      unknowns,
      likelyImportantDependencies: dedupeAndSortStrings(
        likelyImportantDependencies
      )
    }
  };
}

interface DependencyCandidate {
  id: string;
  label: string;
}

function collectDependencyCandidates(
  targetNode: SymbolNode,
  evidenceArtifacts: EvidenceArtifact[]
): DependencyCandidate[] {
  const candidates = new Map<string, DependencyCandidate>();

  for (const artifact of evidenceArtifacts) {
    const nodeId = artifact.metadata?.nodeId;

    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId === targetNode.id) {
      continue;
    }

    if (!candidates.has(nodeId)) {
      candidates.set(nodeId, {
        id: nodeId,
        label: `${artifact.kind}: ${artifact.title}`
      });
    }
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.label !== right.label) {
      return left.label.localeCompare(right.label);
    }

    return left.id.localeCompare(right.id);
  });
}

function formatEvidenceArtifactsForPrompt(
  evidenceArtifacts: EvidenceArtifact[]
): string {
  if (evidenceArtifacts.length === 0) {
    return "- none";
  }

  return evidenceArtifacts
    .map((artifact) => {
      const metadata = formatArtifactMetadata(artifact);

      return [
        `- Artifact ID: ${artifact.id}`,
        `  Kind: ${artifact.kind}`,
        `  Title: ${artifact.title}`,
        `  Symbol ID: ${artifact.symbolId}`,
        metadata ? `  Metadata: ${metadata}` : undefined,
        "  Content:",
        indentBlock(artifact.content.trim() || "<empty>", "    ")
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    })
    .join("\n");
}

function formatArtifactMetadata(artifact: EvidenceArtifact): string | undefined {
  if (!artifact.metadata) {
    return undefined;
  }

  const metadataEntries = Object.entries(artifact.metadata)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort((left, right) => left.localeCompare(right));

  return metadataEntries.length > 0 ? metadataEntries.join(", ") : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  );

  return strings.length === value.length ? strings.map((item) => item.trim()) : undefined;
}

function dedupeAndSortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function indentBlock(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  knownKeys: Set<string>
): boolean {
  return Object.keys(value).every((key) => knownKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateForLog(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
