import type { Logger } from "../core/logger";
import type {
  RepositoryGraph,
  SymbolContext,
  SymbolNode
} from "../types/graph";

export interface CommentGenerationRequest {
  documentUri: string;
  sourceText: string;
  focusText: string;
  targetNode: SymbolNode;
  context?: SymbolContext;
  graph?: RepositoryGraph;
  contextMarkdown?: string;
}

export interface CommentGenerationResult {
  status: "success" | "error";
  message: string;
  markdown?: string;
  rawResponse?: string;
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
- If a dependency's behavior is unclear, say so.
- Be concrete, not generic.
- Mention side effects, mutation, IO, concurrency, and error handling if present.

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
          message: `Ollama request failed with HTTP ${response.status}.`
        };
      }

      const payload = (await response.json()) as OllamaGenerateResponse;
      const rawResponse = payload.response?.trim();

      this.logger.debug(
        `Ollama response body preview: ${truncateForLog(rawResponse ?? payload.error ?? "<empty>", 1200)}`
      );

      if (!rawResponse) {
        this.logger.error(
          `Ollama returned no generated content for ${request.targetNode.name}: ${payload.error ?? "empty response body"}`
        );
        return {
          status: "error",
          message: payload.error || "Ollama returned an empty response."
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
          rawResponse
        };
      }

      return {
        status: "success",
        message: `Generated semantic summary for ${request.targetNode.kind} "${request.targetNode.name}".`,
        markdown: renderSemanticSummaryMarkdown(request, summary),
        rawResponse
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Ollama request failure.";
      this.logger.error(
        `Failed to generate semantic summary for ${request.targetNode.name} via ${endpoint}: ${message}`
      );

      return {
        status: "error",
        message: `Failed to reach Ollama at ${ollamaBaseUrl}: ${message}`
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
    request.contextMarkdown
      ? ["Provided Rust context report:", request.contextMarkdown].join("\n\n")
      : `Focused code:\n\n${request.focusText}`
  ].join("\n");
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
