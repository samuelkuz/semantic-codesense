import test from "node:test";
import assert from "node:assert/strict";

import { EvidenceRepository } from "../evidence/evidenceRepository";
import {
  BudgetedEvidenceRetriever,
  type EvidenceRetrievalBackend,
  type RetrievedArtifactCandidate
} from "../retrieval/evidenceRetriever";
import { InMemoryEvidenceStore, type EvidenceArtifact } from "../types/evidence";
import type { SymbolRef } from "../types/graph";
import type { RetrievalAction } from "../types/retrieval";

test("evidence retriever enforces cumulative budgets and persists results", async () => {
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  repository.saveArtifacts([
    createArtifact("existing-helper-1", "helper_definition", "helper_one", {
      startLine: 10
    }),
    createArtifact("existing-helper-2", "helper_definition", "helper_two", {
      startLine: 20
    })
  ]);

  const retriever = new BudgetedEvidenceRetriever(
    repository,
    createBackend({
      fetch_helper_definition: [
        createCandidate("helper_definition", "helper_three", "tree_sitter", 30),
        createCandidate("helper_definition", "helper_four", "tree_sitter", 40)
      ]
    })
  );

  const artifacts = await retriever.execute([
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    }
  ], createSymbolRef());

  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.metadata?.retrievalRound, 1);
  assert.equal(repository.getArtifactsForSymbol(createSymbolRef().id).length, 3);
});

test("evidence retriever is best effort across failing actions", async () => {
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  const retriever = new BudgetedEvidenceRetriever(
    repository,
    {
      async retrieve(context) {
        if (context.action.type === "fetch_helper_definition") {
          throw new Error("helper lookup failed");
        }

        return [
          createCandidate("type_definition", "ExampleState", "rust_analyzer", 12)
        ];
      }
    }
  );

  const artifacts = await retriever.execute([
    {
      type: "fetch_helper_definition",
      targetName: "helper",
      priority: "high"
    },
    {
      type: "fetch_type_definition",
      targetName: "ExampleState",
      priority: "medium"
    }
  ], createSymbolRef());

  assert.deepEqual(artifacts.map((artifact) => artifact.kind), ["type_definition"]);
});

test("evidence retriever dedupes repeated actions and duplicate artifacts", async () => {
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  repository.saveArtifacts([
    createArtifact("existing-call-site", "call_site", "main", {
      filePath: "/tmp/app.rs",
      startLine: 44,
      symbolName: "main"
    })
  ]);
  const retriever = new BudgetedEvidenceRetriever(
    repository,
    createBackend({
      fetch_call_sites: [
        createCandidate("call_site", "main", "hybrid", 44, "/tmp/app.rs"),
        createCandidate("call_site", "worker", "hybrid", 55, "/tmp/worker.rs")
      ]
    })
  );

  const artifacts = await retriever.execute([
    {
      type: "fetch_call_sites",
      priority: "medium"
    },
    {
      type: "fetch_call_sites",
      priority: "medium"
    }
  ], createSymbolRef());

  assert.deepEqual(artifacts.map((artifact) => artifact.title), ["worker"]);
});

test("evidence retriever tracks retrieval rounds and mixed backends", async () => {
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  repository.saveArtifacts([
    createArtifact("existing-round-1", "helper_definition", "helper_one", {
      retrievalRound: 1,
      retrievalGroupKey: "helper"
    })
  ]);
  const retriever = new BudgetedEvidenceRetriever(
    repository,
    createBackend({
      fetch_type_definition: [
        createCandidate("type_definition", "ExampleState", "rust_analyzer", 12)
      ],
      fetch_field_usages: [
        createCandidate("field_access", "cache usage A", "tree_sitter", 80, "/tmp/cache.rs", "cache"),
        createCandidate("field_access", "cache usage B", "hybrid", 95, "/tmp/cache.rs", "cache")
      ]
    })
  );

  const artifacts = await retriever.execute([
    {
      type: "fetch_type_definition",
      targetName: "ExampleState",
      priority: "high"
    },
    {
      type: "fetch_field_usages",
      targetName: "cache",
      priority: "medium"
    }
  ], createSymbolRef());

  assert.deepEqual(
    artifacts.map((artifact) => artifact.metadata?.retrievedBy),
    ["rust_analyzer", "tree_sitter", "hybrid"]
  );
  assert.ok(artifacts.every((artifact) => artifact.metadata?.retrievalRound === 2));
});

test("evidence retriever enforces trait impl and field usage group budgets", async () => {
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  repository.saveArtifacts([
    createArtifact("existing-trait-group", "trait_impl", "impl existing", {
      retrievalGroupKey: "Display",
      retrievalRound: 1
    }),
    createArtifact("existing-field-group", "field_access", "cache usage existing", {
      retrievalGroupKey: "cache",
      retrievalRound: 1
    })
  ]);
  const retriever = new BudgetedEvidenceRetriever(
    repository,
    createBackend({
      fetch_trait_impls: [
        createCandidate("trait_impl", "impl Debug for Example", "tree_sitter", 100, "/tmp/example.rs", "Debug")
      ],
      fetch_field_usages: [
        createCandidate("field_access", "metrics usage A", "tree_sitter", 81, "/tmp/example.rs", "metrics"),
        createCandidate("field_access", "state usage A", "tree_sitter", 82, "/tmp/example.rs", "state")
      ]
    })
  );

  const artifacts = await retriever.execute([
    {
      type: "fetch_trait_impls",
      targetName: "Debug",
      priority: "medium"
    },
    {
      type: "fetch_field_usages",
      targetName: "metrics",
      priority: "medium"
    }
  ], createSymbolRef());

  assert.deepEqual(
    artifacts.map((artifact) => artifact.title),
    ["metrics usage A"]
  );
});

function createBackend(
  responses: Partial<Record<RetrievalAction["type"], RetrievedArtifactCandidate[]>>
): EvidenceRetrievalBackend {
  return {
    async retrieve(context) {
      return responses[context.action.type] ?? [];
    }
  };
}

function createSymbolRef(): SymbolRef {
  return {
    id: "rust:/tmp/example.rs:example:function:explain:1",
    name: "explain",
    kind: "function",
    filePath: "/tmp/example.rs",
    modulePath: "example",
    language: "rust"
  };
}

function createArtifact(
  id: string,
  kind: EvidenceArtifact["kind"],
  title: string,
  metadata: EvidenceArtifact["metadata"] = {}
): EvidenceArtifact {
  return {
    id,
    symbolId: createSymbolRef().id,
    kind,
    title,
    content: title,
    metadata: {
      filePath: "/tmp/example.rs",
      symbolName: title,
      ...metadata
    }
  };
}

function createCandidate(
  kind: EvidenceArtifact["kind"],
  title: string,
  retrievedBy: "tree_sitter" | "rust_analyzer" | "hybrid",
  startLine: number,
  filePath = "/tmp/example.rs",
  groupKey?: string
): RetrievedArtifactCandidate {
  return {
    kind,
    title,
    content: `snippet for ${title}`,
    retrievedBy,
    groupKey,
    metadata: {
      filePath,
      startLine,
      endLine: startLine,
      symbolName: title
    }
  };
}
