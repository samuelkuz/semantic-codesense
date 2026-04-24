import path from "node:path";

import type { EvidenceArtifact, EvidenceKind } from "../../types/evidence";
import type { SymbolNode } from "../../types/graph";

const KIND_TITLES: Record<EvidenceKind, string> = {
  target_definition: "Target definition",
  helper_definition: "Helper definitions",
  caller: "Callers",
  callee: "Callees",
  call_site: "Call sites",
  type_definition: "Type definitions",
  trait_impl: "Trait / impl context",
  field_access: "Field access",
  module_context: "Module context",
  doc_comment: "Doc comments"
};

const KIND_ORDER: EvidenceKind[] = [
  "target_definition",
  "doc_comment",
  "trait_impl",
  "type_definition",
  "helper_definition",
  "callee",
  "field_access",
  "module_context",
  "caller",
  "call_site"
];

export function renderRustEvidenceArtifactsMarkdown(
  targetNode: SymbolNode,
  artifacts: EvidenceArtifact[]
): string {
  const lines = [
    `# Rust Symbol Context: ${targetNode.name}`,
    "",
    `Target: \`${targetNode.kind}\` in \`${targetNode.modulePath}\``,
    ""
  ];

  const artifactGroups = new Map<EvidenceKind, EvidenceArtifact[]>();

  for (const artifact of artifacts) {
    const group = artifactGroups.get(artifact.kind) ?? [];
    group.push(artifact);
    artifactGroups.set(artifact.kind, group);
  }

  for (const kind of KIND_ORDER) {
    const group = artifactGroups.get(kind);

    if (!group || group.length === 0) {
      continue;
    }

    lines.push(`## ${KIND_TITLES[kind]}`, "");

    for (const artifact of group) {
      lines.push(`### ${artifact.title}`, "");
      lines.push(renderArtifactBody(artifact), "");
    }
  }

  return lines.join("\n").trim();
}

function renderArtifactBody(artifact: EvidenceArtifact): string {
  const language =
    typeof artifact.metadata?.filePath === "string" &&
    path.extname(artifact.metadata.filePath) === ".rs"
      ? "rust"
      : "";
  const content = artifact.content.trim();

  if (shouldRenderAsCodeBlock(artifact.kind, artifact.metadata)) {
    return `\`\`\`${language}\n${content}\n\`\`\``;
  }

  return content;
}

function shouldRenderAsCodeBlock(
  kind: EvidenceKind,
  metadata: EvidenceArtifact["metadata"]
): boolean {
  if (metadata?.renderAsCode === true) {
    return true;
  }

  return (
    kind === "target_definition" ||
    kind === "helper_definition" ||
    kind === "callee" ||
    kind === "type_definition" ||
    kind === "trait_impl" ||
    kind === "field_access" ||
    kind === "call_site"
  );
}
