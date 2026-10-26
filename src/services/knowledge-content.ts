import { mergeReports, redactSensitive } from "../security/redaction.js";
import { detectPromptInjection, sanitizeMarkdown, sanitizeText } from "../security/sanitize.js";
import { SECTION_KEYS, type KnowledgeSections, type SectionKey, type VerificationStatus } from "../types/domain.js";
import { collapseBlankLines, normalizeForComparison, plainExcerpt, singleLine, truncate } from "../utils/text.js";

export interface ValidationInput {
  status: VerificationStatus;
  evidence?: string | undefined;
  limitations?: string | undefined;
}

/** Client-supplied content, before sanitization and redaction. */
export interface ContentFields {
  title?: string | undefined;
  problem?: string | undefined;
  context?: string | undefined;
  solution?: string | undefined;
  implementation?: string | undefined;
  reasoningSummary?: string | undefined;
  followUp?: string | undefined;
  validation?: ValidationInput | undefined;
  summary?: string | undefined;
  tags?: string[] | undefined;
  category?: string | undefined;
}

export interface CleanedContent {
  title: string | undefined;
  sections: Partial<KnowledgeSections>;
  validation: ValidationInput | undefined;
  summary: string | undefined;
  tags: string[] | undefined;
  category: string | undefined;
  redactions: Record<string, number>;
  riskFlags: string[];
}

export type MergeMode = "merge" | "replace";

export const MIN_EVIDENCE_CHARS = 15;
const TAG_PATTERN = /^[\p{L}\p{N}.+#][\p{L}\p{N}.+#_-]{0,49}$/u;
const MAX_TAGS = 20;

/** Sanitizes Markdown, redacts secrets/PII, normalizes tags and flags prompt-injection-like text. */
export function cleanContent(fields: ContentFields, options: { redactEmails: boolean }): CleanedContent {
  const redactions: Record<string, number> = {};
  const clean = (value: string | undefined, markdown: boolean): string | undefined => {
    if (value === undefined) return undefined;
    const sanitized = markdown ? sanitizeMarkdown(value) : sanitizeText(value);
    const { text, report } = redactSensitive(sanitized, options);
    mergeReports(redactions, report);
    return collapseBlankLines(text).trim();
  };

  const sections: Partial<KnowledgeSections> = {};
  const fieldsBySection: Record<SectionKey, string | undefined> = {
    problem: fields.problem,
    context: fields.context,
    solution: fields.solution,
    implementation: fields.implementation,
    reasoning_summary: fields.reasoningSummary,
    validation: undefined,
    follow_up: fields.followUp,
  };
  for (const key of SECTION_KEYS) {
    const value = clean(fieldsBySection[key], true);
    if (value !== undefined) sections[key] = value;
  }

  const validation = fields.validation
    ? {
        status: fields.validation.status,
        evidence: clean(fields.validation.evidence, true) || undefined,
        limitations: clean(fields.validation.limitations, true) || undefined,
      }
    : undefined;
  const title = fields.title === undefined ? undefined : singleLine(clean(fields.title, false) ?? "");
  const summary = fields.summary === undefined ? undefined : truncate(singleLine(clean(fields.summary, false) ?? ""), 400);
  const allText = [title, ...Object.values(sections), validation?.evidence, summary].filter(Boolean).join("\n");

  return {
    title,
    sections,
    validation,
    summary: summary || undefined,
    tags: fields.tags ? normalizeTags(fields.tags) : undefined,
    category: fields.category === undefined ? undefined : normalizeCategory(fields.category),
    redactions,
    riskFlags: detectPromptInjection(allText),
  };
}

/** A success claim without evidence is stored as unverified, never as verified. */
export function deriveVerification(validation: ValidationInput | undefined): { status: VerificationStatus; warning?: string } {
  if (!validation) return { status: "unverified" };
  const claimsSuccess = validation.status === "verified" || validation.status === "partially_verified";
  if (claimsSuccess && (validation.evidence?.trim().length ?? 0) < MIN_EVIDENCE_CHARS) {
    return {
      status: "unverified",
      warning: `Stored as unverified: a "${validation.status}" claim needs evidence (tests or commands run and their results).`,
    };
  }
  return { status: validation.status };
}

export function renderValidation(validation: ValidationInput, status: VerificationStatus): string {
  const lines = [`**Status:** ${status.replace("_", " ")}`];
  if (validation.evidence) lines.push(`**Evidence:** ${validation.evidence}`);
  if (validation.limitations) lines.push(`**Known limitations:** ${validation.limitations}`);
  return lines.join("\n\n");
}

/**
 * merge: appends new text to existing sections (skipping text that is already contained);
 * replace: overwrites the provided sections. Returns the keys that actually changed.
 */
export function mergeSections(
  existing: KnowledgeSections,
  incoming: Partial<KnowledgeSections>,
  mode: MergeMode,
): { sections: KnowledgeSections; changed: SectionKey[] } {
  const result: KnowledgeSections = { ...existing };
  const changed: SectionKey[] = [];
  for (const key of SECTION_KEYS) {
    const next = incoming[key];
    if (next === undefined) continue;
    const current = existing[key] ?? "";
    let value: string;
    if (mode === "replace" || current.trim() === "") value = next;
    else if (next.trim() === "" || normalizeForComparison(current).includes(normalizeForComparison(next))) value = current;
    else value = `${current}\n\n${next}`;
    if (value !== current) {
      setSection(result, key, value);
      changed.push(key);
    }
  }
  return { sections: result, changed };
}

export function normalizeTags(tags: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const raw of tags) {
    const tag = raw.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
    if (TAG_PATTERN.test(tag)) unique.add(tag);
    if (unique.size >= MAX_TAGS) break;
  }
  return [...unique].sort();
}

export function normalizeCategory(value: string | undefined): string {
  const category = (value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return category || "general";
}

/** Tag text indexed with top weight, including punctuation-free variants (node.js -> "node js"). */
export function buildKeywords(tags: readonly string[]): string {
  const words = tags.flatMap((tag) => [tag, tag.replace(/[.#+_-]+/g, " ").trim()]);
  return [...new Set(words.filter(Boolean))].join(" ");
}

/** Stored search summary: the client's summary if given, otherwise a lightweight extraction (no LLM call). */
export function buildSummary(sections: KnowledgeSections, provided?: string): string {
  if (provided?.trim()) return truncate(provided.trim(), 400);
  return truncate(
    `Problem: ${plainExcerpt(sections.problem, 150)} Solution: ${plainExcerpt(sections.solution, 230)}`,
    400,
  );
}

export function sourceClientLabel(value: string | undefined): string | null {
  const label = (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return label || null;
}

function setSection(sections: KnowledgeSections, key: SectionKey, value: string): void {
  if (key === "problem" || key === "solution") {
    sections[key] = value;
  } else if (value.trim() === "") {
    delete sections[key];
  } else {
    sections[key] = value;
  }
}
