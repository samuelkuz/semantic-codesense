import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../core/logger";
import { createHypothesisGenerationService } from "../services/hypothesisGenerationService";
import type { EvidenceArtifact } from "../types/evidence";

class TestLogger implements Logger {
  public readonly warnings: string[] = [];

  debug(message: string): void {
    void message;
  }

  info(message: string): void {
    void message;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    void message;
  }

  show(preserveFocus?: boolean): void {
    void preserveFocus;
  }

  dispose(): void {}
}

test("hypothesis generation service includes the prompt contract and artifact ids", async () => {
  let receivedPrompt = "";
  const service = createHypothesisGenerationService(
    new TestLogger(),
    {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3-coder:30b"
    },
    (async (_, init) => {
      const body = JSON.parse(String(init?.body)) as { prompt?: string };
      receivedPrompt = body.prompt ?? "";

      return new Response(
        JSON.stringify({
          response: JSON.stringify({
            purpose: "Coordinates helper logic for the main workflow.",
            keyBehavior: ["Delegates setup to a helper function."],
            sideEffects: ["Mutates cached state."],
            confidence: "medium",
            unknowns: [
              {
                kind: "missing_helper_logic",
                question: "What does helper do internally?",
                targetSymbolName: "helper",
                priority: "high",
                evidenceArtifactIds: ["artifact-2"]
              }
            ],
            likelyImportantDependencies: [
              "rust:/tmp/example.rs:example:function:helper:5"
            ]
          })
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }) as typeof fetch
  );

  const evidenceArtifacts: EvidenceArtifact[] = [
    {
      id: "artifact-1",
      symbolId: "rust:/tmp/example.rs:example:function:explain:1",
      kind: "target_definition",
      title: "function `explain`",
      content: "fn explain() -> usize { helper() }",
      metadata: {
        nodeId: "rust:/tmp/example.rs:example:function:explain:1",
        filePath: "/tmp/example.rs",
        startLine: 1
      }
    },
    {
      id: "artifact-2",
      symbolId: "rust:/tmp/example.rs:example:function:explain:1",
      kind: "helper_definition",
      title: "function `helper`",
      content: "fn helper() -> usize { todo!() }",
      metadata: {
        nodeId: "rust:/tmp/example.rs:example:function:helper:5",
        filePath: "/tmp/example.rs",
        startLine: 5
      }
    }
  ];

  const result = await service.generateDraft({
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
      signature: "fn explain() -> usize"
    },
    evidenceArtifacts
  });

  assert.equal(result.status, "success");
  assert.ok(result.draft);
  assert.match(
    receivedPrompt,
    /Summarize only from the evidence provided\./i
  );
  assert.match(receivedPrompt, /Explicitly state uncertainty\./i);
  assert.match(receivedPrompt, /Do not guess hidden behavior\./i);
  assert.match(
    receivedPrompt,
    /Produce unknowns only when more evidence would materially improve the answer\./i
  );
  assert.match(receivedPrompt, /Artifact ID: artifact-1/);
  assert.match(
    receivedPrompt,
    /Known symbol IDs you may reference in likelyImportantDependencies:/
  );
  assert.match(
    receivedPrompt,
    /Copy dependency IDs exactly from the provided candidate list; do not rewrite, shorten, normalize, or invent IDs\./i
  );
  assert.deepEqual(result.draft?.evidenceArtifactIds, ["artifact-1", "artifact-2"]);
  assert.match(result.draft?.evidenceSnapshotId ?? "", /^evidence-snapshot:/);
  assert.deepEqual(result.draft?.likelyImportantDependencies, [
    "rust:/tmp/example.rs:example:function:helper:5"
  ]);
});

test("hypothesis generation service rejects malformed draft hypothesis json", async () => {
  const service = createHypothesisGenerationService(
    new TestLogger(),
    {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3-coder:30b"
    },
    (async () =>
      new Response(
        JSON.stringify({
          response: "{\"purpose\": \"oops\""
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )) as typeof fetch
  );

  const result = await service.generateDraft({
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
      signature: "fn explain() -> usize"
    },
    evidenceArtifacts: [
      {
        id: "artifact-1",
        symbolId: "rust:/tmp/example.rs:example:function:explain:1",
        kind: "target_definition",
        title: "function `explain`",
        content: "fn explain() -> usize { helper() }"
      }
    ]
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /could not be parsed as json/i);
});

test("hypothesis generation service rejects unknown artifact references", async () => {
  const service = createHypothesisGenerationService(
    new TestLogger(),
    {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3-coder:30b"
    },
    (async () =>
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            keyBehavior: ["Delegates setup to helper."],
            sideEffects: [],
            confidence: "low",
            unknowns: [
              {
                kind: "missing_helper_logic",
                question: "What does helper do internally?",
                priority: "high",
                evidenceArtifactIds: ["artifact-missing"]
              }
            ],
            likelyImportantDependencies: []
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

  const result = await service.generateDraft({
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
      signature: "fn explain() -> usize"
    },
    evidenceArtifacts: [
      {
        id: "artifact-1",
        symbolId: "rust:/tmp/example.rs:example:function:explain:1",
        kind: "target_definition",
        title: "function `explain`",
        content: "fn explain() -> usize { helper() }"
      }
    ]
  });

  assert.equal(result.status, "error");
  assert.match(result.message, /did not match the required schema/i);
});

test("hypothesis generation service drops invalid dependency ids instead of failing the draft", async () => {
  const logger = new TestLogger();
  const service = createHypothesisGenerationService(
    logger,
    {
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "qwen3-coder:30b"
    },
    (async () =>
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            keyBehavior: ["Delegates setup to helper."],
            sideEffects: ["Mutates cached state."],
            confidence: "medium",
            unknowns: [],
            likelyImportantDependencies: [
              "rust:/tmp/example.rs:example:function:helper:5",
              "rust:/tmp/example.rs:example:function:missing:9"
            ]
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

  const result = await service.generateDraft({
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
      signature: "fn explain() -> usize"
    },
    evidenceArtifacts: [
      {
        id: "artifact-1",
        symbolId: "rust:/tmp/example.rs:example:function:explain:1",
        kind: "target_definition",
        title: "function `explain`",
        content: "fn explain() -> usize { helper() }",
        metadata: {
          nodeId: "rust:/tmp/example.rs:example:function:explain:1",
          filePath: "/tmp/example.rs",
          startLine: 1
        }
      },
      {
        id: "artifact-2",
        symbolId: "rust:/tmp/example.rs:example:function:explain:1",
        kind: "helper_definition",
        title: "function `helper`",
        content: "fn helper() -> usize { todo!() }",
        metadata: {
          nodeId: "rust:/tmp/example.rs:example:function:helper:5",
          filePath: "/tmp/example.rs",
          startLine: 5
        }
      }
    ]
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.draft?.likelyImportantDependencies, [
    "rust:/tmp/example.rs:example:function:helper:5"
  ]);
  assert.equal(logger.warnings.length, 1);
  assert.match(
    logger.warnings[0] ?? "",
    /Dropped invalid likelyImportantDependencies/i
  );
});
