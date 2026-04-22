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

  dispose(): void {}
}

test("placeholder generation service returns a not-implemented response", async () => {
  const service = createCommentGenerationService(new TestLogger());

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

  assert.equal(result.status, "not-implemented");
  assert.match(result.message, /not implemented yet/i);
  assert.match(result.message, /function "explain"/i);
});
