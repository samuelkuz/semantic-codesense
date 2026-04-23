import test from "node:test";
import assert from "node:assert/strict";

import {
  createCommentGenerationService,
  type CommentGenerationRequest
} from "../services/commentGenerationService";
import type { Logger } from "../core/logger";

class TestLogger implements Logger {
  debug(message: string): void {
    void message;
  }

  info(message: string): void {
    void message;
  }

  warn(message: string): void {
    void message;
  }

  error(message: string): void {
    void message;
  }

  show(preserveFocus?: boolean): void {
    void preserveFocus;
  }

  dispose(): void {}
}

test("comment generation service formats Ollama JSON into markdown", async () => {
  const service = createCommentGenerationService(
    new TestLogger(),
    {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3-coder:30b"
    },
    (async () =>
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            summary: "Creates and initializes an example symbol.",
            belongs_to: {
              struct: "Example",
              trait: "unknown",
              module: "example"
            },
            responsibilities: [
              "Builds the example symbol",
              "Returns a simple result"
            ],
            helper_functions: [
              {
                name: "helper_one",
                why_it_matters: "Prepares required state."
              }
            ],
            used_by: [
              {
                name: "main",
                role: "Entry point that triggers example setup."
              }
            ],
            side_effects: ["allocates example state"],
            unknowns: ["No external helper implementation was provided."]
          })
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )) as typeof fetch
  );

  const request: CommentGenerationRequest = {
    documentUri: "file:///tmp/example.rs",
    sourceText: "fn explain() {}",
    focusText: "fn explain() {}",
    targetNode: {
      id: "rust:/tmp/example.rs:example:function:explain:1",
      filePath: "/tmp/example.rs",
      modulePath: "example",
      language: "rust",
      kind: "function",
      name: "explain",
      span: {
        startLine: 1,
        endLine: 1
      },
      signature: "fn explain() {}"
    }
  };

  const result = await service.generate(request);

  assert.equal(result.status, "success");
  assert.match(result.message, /generated semantic summary/i);
  assert.match(result.markdown ?? "", /Semantic Summary: explain/i);
  assert.match(result.markdown ?? "", /helper_one/i);
  assert.match(result.markdown ?? "", /main/i);
});
