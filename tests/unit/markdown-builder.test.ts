import { describe, expect, it } from "vitest";
import { buildMarkdown, computeContentHash, exportFileName, type MarkdownMetadata } from "../../src/services/markdown-builder.js";
import { generateKnowledgeId } from "../../src/utils/ids.js";

const meta: MarkdownMetadata = {
  knowledgeId: generateKnowledgeId(),
  title: "PostgreSQL JSONB Query Troubleshooting",
  category: "technical",
  tags: ["jsonb", "postgresql"],
  namespace: "default",
  createdAt: new Date("2026-10-01T10:00:00.000Z"),
  updatedAt: new Date("2026-10-02T10:00:00.000Z"),
  createdBy: "alice",
  visibility: "shared",
  sourceClient: "claude-code",
  version: 1,
  verificationStatus: "verified",
};

describe("markdown builder", () => {
  it("renders front matter and only the non-empty sections", () => {
    const md = buildMarkdown(meta, { problem: "P", solution: "S", context: "   ", implementation: "code" });
    expect(md.startsWith('---\ntitle: "PostgreSQL JSONB Query Troubleshooting"')).toBe(true);
    expect(md).toContain(`knowledge_id: "${meta.knowledgeId}"`);
    expect(md).toContain('tags:\n  - "jsonb"\n  - "postgresql"');
    expect(md).toContain('created_at: "2026-10-01T10:00:00.000Z"');
    expect(md).toContain('source_client: "claude-code"');
    expect(md).toContain("version: 1");
    expect(md).toContain("## Problem\n\nP");
    expect(md).toContain("## Implementation\n\ncode");
    expect(md).not.toContain("## Context");
  });

  it("escapes YAML so titles cannot inject front-matter keys", () => {
    const md = buildMarkdown({ ...meta, title: 'Fix "quoted": value\n---\ninjected: true' }, { problem: "P", solution: "S" });
    const frontMatter = md.split("\n---\n")[0] ?? "";
    expect(frontMatter).toContain('title: "Fix \\"quoted\\": value\\n---\\ninjected: true"');
    expect(frontMatter).not.toContain("\ninjected: true");
  });

  it("hashes meaningful content only and builds safe file names", () => {
    const sections = { problem: "P", solution: "S" };
    const hash = computeContentHash("T", sections, ["x"], "verified");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash("T", { ...sections }, ["x"], "verified")).toBe(hash);
    expect(computeContentHash("T", { problem: "P", solution: "S2" }, ["x"], "verified")).not.toBe(hash);
    expect(exportFileName("Café: ünïcode / paths?", meta.knowledgeId)).toMatch(/^cafe-unicode-paths-[0-9a-z]{8}\.md$/);
  });
});
