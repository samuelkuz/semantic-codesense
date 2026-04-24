import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryEvidenceStore,
  type EvidenceArtifact
} from "../types/evidence";

test("in-memory evidence store indexes artifacts by symbol and id", () => {
  const store = new InMemoryEvidenceStore();
  const artifacts: EvidenceArtifact[] = [
    {
      id: "artifact-1",
      symbolId: "symbol-a",
      kind: "target_definition",
      title: "Target definition",
      content: "fn explain() {}"
    },
    {
      id: "artifact-2",
      symbolId: "symbol-a",
      kind: "doc_comment",
      title: "Docs",
      content: "Explains the function."
    },
    {
      id: "artifact-3",
      symbolId: "symbol-b",
      kind: "caller",
      title: "Caller",
      content: "main()"
    }
  ];

  store.addArtifacts(artifacts);

  assert.deepEqual(
    store.getArtifactsForSymbol("symbol-a").map((artifact) => artifact.id),
    ["artifact-1", "artifact-2"]
  );
  assert.equal(store.getArtifactById("artifact-3")?.symbolId, "symbol-b");
  assert.equal(store.getArtifactById("missing"), undefined);
});
