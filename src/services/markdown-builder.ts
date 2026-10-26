import { SECTION_KEYS, type KnowledgeSections, type SectionKey, type VerificationStatus, type Visibility } from "../types/domain.js";
import { fileSlug, sha256Hex, singleLine } from "../utils/text.js";

export const SECTION_TITLES: Record<SectionKey, string> = {
  problem: "Problem",
  context: "Context",
  solution: "Solution",
  implementation: "Implementation",
  reasoning_summary: "Reasoning Summary",
  validation: "Validation",
  follow_up: "Follow-up",
};

export interface MarkdownMetadata {
  knowledgeId: string;
  title: string;
  category: string;
  tags: readonly string[];
  namespace: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  visibility: Visibility;
  sourceClient: string | null;
  version: number;
  verificationStatus: VerificationStatus;
}

/** Renders the canonical Markdown document (YAML front matter + only the non-empty sections). */
export function buildMarkdown(meta: MarkdownMetadata, sections: KnowledgeSections): string {
  const frontMatter = [
    "---",
    `title: ${yamlString(meta.title)}`,
    `knowledge_id: ${yamlString(meta.knowledgeId)}`,
    `category: ${yamlString(meta.category)}`,
    meta.tags.length > 0 ? `tags:\n${meta.tags.map((tag) => `  - ${yamlString(tag)}`).join("\n")}` : "tags: []",
    `namespace: ${yamlString(meta.namespace)}`,
    `created_at: ${yamlString(meta.createdAt.toISOString())}`,
    `updated_at: ${yamlString(meta.updatedAt.toISOString())}`,
    `created_by: ${yamlString(meta.createdBy)}`,
    `visibility: ${yamlString(meta.visibility)}`,
    `source_client: ${meta.sourceClient ? yamlString(meta.sourceClient) : "null"}`,
    `version: ${meta.version}`,
    `verification_status: ${yamlString(meta.verificationStatus)}`,
    "---",
  ].join("\n");
  return `${frontMatter}\n\n# ${singleLine(meta.title)}\n\n${renderSections(sections)}\n`;
}

export function renderSections(sections: KnowledgeSections, keys: readonly SectionKey[] = SECTION_KEYS): string {
  return keys
    .flatMap((key) => {
      const body = sections[key]?.trim();
      return body ? [`## ${SECTION_TITLES[key]}\n\n${body}`] : [];
    })
    .join("\n\n");
}

/** Hash of the meaningful content (not timestamps), used for ETags and "already seen" checks. */
export function computeContentHash(
  title: string,
  sections: KnowledgeSections,
  tags: readonly string[],
  verificationStatus: VerificationStatus,
): string {
  return sha256Hex([title, tags.join(","), verificationStatus, renderSections(sections)].join("\n"));
}

export function exportFileName(title: string, knowledgeId: string): string {
  return `${fileSlug(title, 60)}-${knowledgeId.slice(-8)}.md`;
}

/** JSON strings are valid YAML 1.2 double-quoted scalars, so no YAML library is needed. */
function yamlString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
