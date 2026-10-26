import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n");
}

export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Unicode-aware key used for exact title matching (keeps non-Latin scripts intact). */
export function titleKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

/** ASCII-only slug for file names. */
export function fileSlug(value: string, maxLength = 80): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "knowledge";
}

/** Lowercase, punctuation-insensitive form used for fingerprints and containment checks. */
export function normalizeForComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`*_~>#|[\](){}"'.,;:!?\\/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, Math.max(0, maxChars - 1));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Plain-text excerpt of Markdown for search summaries. Drops fenced code, link targets, line-start markers and
 * emphasis delimiters, but keeps characters that carry meaning in technical text (snake_case, @>, ->, ~/, |).
 */
export function plainExcerpt(markdown: string, maxChars: number): string {
  const text = markdown
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, " [code] ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  return truncate(singleLine(text), maxChars);
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
