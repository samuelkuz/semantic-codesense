import type { Logger } from "../core/logger";
import type { EvidenceArtifact } from "../types/evidence";
import type {
  AnalysisRoundResult,
  AnalysisStopReason
} from "../types/analysis";
import type {
  RepositoryGraph,
  SymbolContext,
  SymbolNode
} from "../types/graph";
import type { DraftHypothesis } from "../types/hypothesis";

export interface CommentGenerationRequest {
  documentUri: string;
  sourceText: string;
  focusText: string;
  targetNode: SymbolNode;
  context?: SymbolContext;
  graph?: RepositoryGraph;
  evidenceArtifacts?: EvidenceArtifact[];
  finalHypothesis?: DraftHypothesis;
  retrievalRounds?: AnalysisRoundResult[];
  analysisStopReason?: AnalysisStopReason;
}

export interface CommentGenerationResult {
  status: "success" | "error";
  message: string;
  markdown?: string;
  rawResponse?: string;
  prompt?: string;
}

export interface CommentGenerationService {
  generate(
    request: CommentGenerationRequest
  ): Promise<CommentGenerationResult>;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

interface SemanticSummaryJson {
  summary?: string;
  belongs_to?: {
    struct?: string;
    trait?: string;
    module?: string;
  };
  responsibilities?: string[];
  helper_functions?: Array<{
    name?: string;
    why_it_matters?: string;
  }>;
  used_by?: Array<{
    name?: string;
    role?: string;
  }>;
  side_effects?: string[];
  unknowns?: string[];
}

type FetchLike = typeof fetch;

export interface CommentGenerationServiceOptions {
  ollamaBaseUrl: string;
  ollamaModel: string;
}

const BASE_PROMPT = `You are analyzing Rust code for a developer unfamiliar with this codebase.

Your job:
1. Explain what the target function does.
2. Explain what struct/trait/module context it belongs to.
3. Explain the most important helper functions it relies on.
4. Explain where it is used in the broader system.
5. Point out uncertainty instead of guessing.

Rules:
- Only use the provided code/context.
- Use the structured sections below as the primary source of truth.
- If a dependency's behavior is unclear, say so.
- Be concrete, not generic.
- Mention side effects, mutation, IO, concurrency, and error handling if present.
- If the final hypothesis and retrieved evidence disagree, prefer the evidence and call out the uncertainty.

Output format:
- One sentence summary
- Detailed explanation
- Parent type / module context
- Important helper functions
- Likely call flow / usage context
- Risks / caveats / unknowns`;

class OllamaCommentGenerationService
  implements CommentGenerationService
{
  constructor(
    private readonly logger: Logger,
    private readonly options: CommentGenerationServiceOptions,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async generate(
    request: CommentGenerationRequest
  ): Promise<CommentGenerationResult> {
    const { ollamaBaseUrl, ollamaModel } = this.options;
    const prompt = buildPrompt(request);
    const endpoint = `${ollamaBaseUrl}/api/generate`;

    this.logger.info(
      `Generating semantic summary for ${request.targetNode.kind} "${request.targetNode.name}" via Ollama model "${ollamaModel}".`
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
          `Ollama request failed for ${request.targetNode.name}: HTTP ${response.status} ${response.statusText || ""}`.trim()
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
          `Ollama returned no generated content for ${request.targetNode.name}: ${payload.error ?? "empty response body"}`
        );
        return {
          status: "error",
          message: payload.error || "Ollama returned an empty response.",
          prompt
        };
      }

      const summary = parseSemanticSummary(rawResponse);

      if (!summary) {
        this.logger.error(
          `Ollama returned non-JSON content for ${request.targetNode.name}. Preview: ${truncateForLog(rawResponse, 600)}`
        );
        return {
          status: "error",
          message: "Ollama returned a response that could not be parsed as JSON.",
          rawResponse,
          prompt
        };
      }

      return {
        status: "success",
        message: `Generated semantic summary for ${request.targetNode.kind} "${request.targetNode.name}".`,
        markdown: renderSemanticSummaryMarkdown(request, summary),
        rawResponse,
        prompt
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Ollama request failure.";
      this.logger.error(
        `Failed to generate semantic summary for ${request.targetNode.name} via ${endpoint}: ${message}`
      );

      return {
        status: "error",
        message: `Failed to reach Ollama at ${ollamaBaseUrl}: ${message}`,
        prompt
      };
    }
  }
}

export function createCommentGenerationService(
  logger: Logger,
  options: CommentGenerationServiceOptions,
  fetchImpl?: FetchLike
): CommentGenerationService {
  return new OllamaCommentGenerationService(logger, options, fetchImpl);
}

function buildPrompt(request: CommentGenerationRequest): string {
  const schema = `{
  "summary": "...",
  "belongs_to": {
    "struct": "...",
    "trait": "...",
    "module": "..."
  },
  "responsibilities": ["...", "..."],
  "helper_functions": [
    {
      "name": "...",
      "why_it_matters": "..."
    }
  ],
  "used_by": [
    {
      "name": "...",
      "role": "..."
    }
  ],
  "side_effects": ["filesystem write", "mutates self.cache"],
  "unknowns": ["helper X implementation not provided"]
}`;

  return [
    BASE_PROMPT,
    "",
    "Return only valid JSON with this shape:",
    schema,
    "",
    `Target symbol: ${request.targetNode.kind} ${request.targetNode.name}`,
    "",
    "## Target symbol",
    formatTargetNodeForPrompt(request.targetNode),
    "",
    "## Focused code",
    request.focusText,
    "",
    "## Symbol context",
    formatSymbolContextForPrompt(request.context),
    "",
    "## Selected graph neighbors",
    formatGraphNeighborsForPrompt(request.graph, request.targetNode.id),
    "",
    "## Final hypothesis",
    formatFinalHypothesisForPrompt(request.finalHypothesis),
    "",
    "## Retrieval history",
    formatRetrievalHistoryForPrompt(
      request.retrievalRounds,
      request.analysisStopReason
    ),
    "",
    request.evidenceArtifacts && request.evidenceArtifacts.length > 0
      ? ["## Collected evidence artifacts", formatEvidenceArtifactsForPrompt(request.evidenceArtifacts)].join("\n\n")
      : ["## Source document excerpt", request.sourceText].join("\n\n")
  ].join("\n");
}

function formatTargetNodeForPrompt(targetNode: SymbolNode): string {
  return [
    `ID: ${targetNode.id}`,
    `Kind: ${targetNode.kind}`,
    `Name: ${targetNode.name}`,
    `Module: ${targetNode.modulePath}`,
    `File: ${targetNode.filePath}`,
    `Span: ${targetNode.span.startLine}-${targetNode.span.endLine}`,
    targetNode.signature ? `Signature: ${targetNode.signature}` : undefined,
    targetNode.docs ? `Docs: ${targetNode.docs}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatSymbolContextForPrompt(context: SymbolContext | undefined): string {
  if (!context) {
    return "No symbol context available.";
  }

  return [
    formatNodeCollection("Parents", context.parents),
    formatNodeCollection("Children", context.children),
    formatNodeCollection("Callers", context.callers),
    formatNodeCollection("Callees", context.callees),
    formatNodeCollection("Related types", context.relatedTypes),
    formatNodeCollection("Imported symbols", context.importedSymbols),
    formatEdgeCollection("Outgoing edges", context.outgoingEdges),
    formatEdgeCollection("Incoming edges", context.incomingEdges)
  ].join("\n\n");
}

function formatGraphNeighborsForPrompt(
  graph: RepositoryGraph | undefined,
  targetNodeId: string
): string {
  if (!graph) {
    return "No graph data available.";
  }

  const neighborIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.from === targetNodeId) {
      neighborIds.add(edge.to);
    }

    if (edge.to === targetNodeId) {
      neighborIds.add(edge.from);
    }
  }

  const neighborNodes = [...neighborIds]
    .map((nodeId) => graph.nodes.find((node) => node.id === nodeId))
    .filter((node): node is SymbolNode => node !== undefined)
    .slice(0, 12);

  if (neighborNodes.length === 0) {
    return "No direct graph neighbors available.";
  }

  return neighborNodes
    .map((node) => {
      const connectingEdges = graph.edges
        .filter(
          (edge) =>
            (edge.from === targetNodeId && edge.to === node.id) ||
            (edge.to === targetNodeId && edge.from === node.id)
        )
        .map((edge) =>
          edge.from === targetNodeId
            ? `${edge.kind} -> ${node.name}`
            : `${node.name} -> ${edge.kind}`
        );

      return [
        `- ${node.kind} \`${node.name}\` (${node.modulePath})`,
        `  id=${node.id}`,
        `  edges=${connectingEdges.join(", ")}`
      ].join("\n");
    })
    .join("\n");
}

function formatFinalHypothesisForPrompt(
  finalHypothesis: DraftHypothesis | undefined
): string {
  if (!finalHypothesis) {
    return "No final hypothesis available.";
  }

  return [
    `Evidence snapshot: ${finalHypothesis.evidenceSnapshotId}`,
    `Confidence: ${finalHypothesis.confidence}`,
    finalHypothesis.purpose ? `Purpose: ${finalHypothesis.purpose}` : undefined,
    `Key behavior: ${formatInlineList(finalHypothesis.keyBehavior)}`,
    `Side effects: ${formatInlineList(finalHypothesis.sideEffects)}`,
    `Likely important dependencies: ${formatInlineList(finalHypothesis.likelyImportantDependencies)}`,
    finalHypothesis.unknowns.length > 0
      ? [
          "Unknowns:",
          ...finalHypothesis.unknowns.map(
            (unknown) =>
              `- [${unknown.priority}] ${unknown.kind}: ${unknown.question} (target=${unknown.targetSymbolName ?? "n/a"}, evidence=${unknown.evidenceArtifactIds.join(", ") || "none"})`
          )
        ].join("\n")
      : "Unknowns: none"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatRetrievalHistoryForPrompt(
  retrievalRounds: AnalysisRoundResult[] | undefined,
  analysisStopReason: AnalysisStopReason | undefined
): string {
  if (!retrievalRounds || retrievalRounds.length === 0) {
    return analysisStopReason
      ? `No retrieval rounds recorded. Stop reason: ${analysisStopReason}`
      : "No retrieval rounds recorded.";
  }

  return [
    analysisStopReason ? `Stop reason: ${analysisStopReason}` : undefined,
    ...retrievalRounds.map((round) =>
      [
        `Round ${round.round}: draftConfidence=${round.draft.confidence}`,
        `  plannedActions=${
          round.plannedActions.length > 0
            ? round.plannedActions
                .map(
                  (action) =>
                    `${action.type}${action.targetName ? `(${action.targetName})` : ""}:${action.priority}`
                )
                .join(", ")
            : "none"
        }`,
        `  retrievedArtifacts=${
          round.retrievedArtifacts.length > 0
            ? round.retrievedArtifacts
                .map((artifact) => `${artifact.kind}:${artifact.id}`)
                .join(", ")
            : "none"
        }`
      ].join("\n")
    )
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

function parseSemanticSummary(
  rawResponse: string
): SemanticSummaryJson | undefined {
  const fencedJson = rawResponse.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fencedJson?.[1] ?? rawResponse;

  try {
    return JSON.parse(candidate) as SemanticSummaryJson;
  } catch {
    return undefined;
  }
}

function renderSemanticSummaryMarkdown(
  request: CommentGenerationRequest,
  summary: SemanticSummaryJson
): string {
  const responsibilities = formatList(summary.responsibilities);
  const helperFunctions = formatObjectList(
    summary.helper_functions,
    (item) =>
      item.name
        ? `- \`${item.name}\`${item.why_it_matters ? `: ${item.why_it_matters}` : ""}`
        : undefined
  );
  const usedBy = formatObjectList(
    summary.used_by,
    (item) =>
      item.name
        ? `- \`${item.name}\`${item.role ? `: ${item.role}` : ""}`
        : undefined
  );
  const sideEffects = formatList(summary.side_effects);
  const unknowns = formatList(summary.unknowns);
  const belongsTo = [
    `- Struct: ${summary.belongs_to?.struct ?? "unknown"}`,
    `- Trait: ${summary.belongs_to?.trait ?? "unknown"}`,
    `- Module: ${summary.belongs_to?.module ?? request.targetNode.modulePath}`
  ].join("\n");
  const risksAndUnknowns = [sideEffects, unknowns]
    .filter((section) => section !== "_None provided._")
    .join("\n\n");

  return [
    `# Semantic Summary: ${request.targetNode.name}`,
    "",
    `Target: \`${request.targetNode.kind}\` in \`${request.targetNode.modulePath}\``,
    "",
    "## One sentence summary",
    "",
    summary.summary ?? "_No summary returned._",
    "",
    "## Parent type / module context",
    "",
    belongsTo,
    "",
    "## Detailed explanation",
    "",
    responsibilities,
    "",
    "## Important helper functions",
    "",
    helperFunctions,
    "",
    "## Likely call flow / usage context",
    "",
    usedBy,
    "",
    "## Risks / caveats / unknowns",
    "",
    risksAndUnknowns || "_No explicit risks or unknowns returned._"
  ].join("\n");
}

function formatList(items: string[] | undefined): string {
  if (!items || items.length === 0) {
    return "_None provided._";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatObjectList<T>(
  items: T[] | undefined,
  formatter: (item: T) => string | undefined
): string {
  if (!items || items.length === 0) {
    return "_None provided._";
  }

  const formatted = items
    .map(formatter)
    .filter((item): item is string => item !== undefined);

  return formatted.length > 0 ? formatted.join("\n") : "_None provided._";
}

function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
}

function formatEvidenceArtifactsForPrompt(
  evidenceArtifacts: EvidenceArtifact[]
): string {
  return evidenceArtifacts
    .map((artifact) => {
      const metadata = artifact.metadata
        ? Object.entries(artifact.metadata)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(", ")
        : undefined;

      return [
        `### ${artifact.kind}: ${artifact.title}`,
        metadata ? `Metadata: ${metadata}` : undefined,
        artifact.content
      ]
        .filter((section): section is string => section !== undefined)
        .join("\n");
    })
    .join("\n\n");
}

function formatNodeCollection(label: string, nodes: SymbolNode[]): string {
  return `${label}: ${
    nodes.length > 0
      ? nodes
          .map((node) => `${node.kind} \`${node.name}\` [${node.id}]`)
          .join(", ")
      : "none"
  }`;
}

function formatEdgeCollection(
  label: string,
  edges: RepositoryGraph["edges"]
): string {
  return `${label}: ${
    edges.length > 0
      ? edges
          .map((edge) => `${edge.from} -${edge.kind}-> ${edge.to}`)
          .join(", ")
      : "none"
  }`;
}

function formatInlineList(items: string[]): string {
  return items.length > 0 ? items.join("; ") : "none";
}
