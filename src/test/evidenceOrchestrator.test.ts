import test from "node:test";
import assert from "node:assert/strict";

import type { EvidenceCollector } from "../evidence/evidenceCollector";
import { EvidenceOrchestrator } from "../evidence/evidenceOrchestrator";
import { EvidenceRepository } from "../evidence/evidenceRepository";
import {
  InMemoryEvidenceStore,
  type EvidenceArtifact
} from "../types/evidence";

interface TestInput {
  targetNode: {
    id: string;
  };
}

test("evidence orchestrator collects and persists artifacts through the repository", async () => {
  const collector: EvidenceCollector<TestInput> = {
    async collect(input: TestInput): Promise<EvidenceArtifact[]> {
      return [
        {
          id: "artifact-1",
          symbolId: input.targetNode.id,
          kind: "target_definition",
          title: "Target definition",
          content: "fn explain() {}"
        }
      ];
    }
  };
  const repository = new EvidenceRepository(new InMemoryEvidenceStore());
  const orchestrator = new EvidenceOrchestrator(collector, repository);

  const artifacts = await orchestrator.collectAndPersist({
    targetNode: {
      id: "symbol-a"
    }
  });

  assert.deepEqual(
    artifacts.map((artifact) => artifact.id),
    ["artifact-1"]
  );
  assert.equal(
    repository.getArtifactById("artifact-1")?.symbolId,
    "symbol-a"
  );
});
