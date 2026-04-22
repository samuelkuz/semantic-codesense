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
}

export interface CommentGenerationResult {
  status: "not-implemented";
  message: string;
}

export interface CommentGenerationService {
  generate(
    request: CommentGenerationRequest
  ): Promise<CommentGenerationResult>;
}

class PlaceholderCommentGenerationService
  implements CommentGenerationService
{
  constructor(private readonly logger: Logger) {}

  async generate(
    request: CommentGenerationRequest
  ): Promise<CommentGenerationResult> {
    this.logger.info(
      `Received placeholder generation request for ${request.targetNode.kind} "${request.targetNode.name}" at ${request.documentUri}.`
    );

    const contextSummary = request.context
      ? ` Context: ${request.context.callees.length} callees, ${request.context.callers.length} callers, ${request.context.relatedTypes.length} related types.`
      : "";

    return {
      status: "not-implemented",
      message:
        `Semantic CodeSense is wired up for Rust symbols, but AI comment generation ` +
        `is not implemented yet for ${request.targetNode.kind} "${request.targetNode.name}".` +
        contextSummary
    };
  }
}

export function createCommentGenerationService(
  logger: Logger
): CommentGenerationService {
  return new PlaceholderCommentGenerationService(logger);
}
