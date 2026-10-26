import { neutralizeWrapperTags } from "../security/sanitize.js";
import type { SearchResponse } from "../services/knowledge-search.js";
import type { DocumentView, WriteNotes } from "../services/knowledge-storage.js";
import { renderSections } from "../services/markdown-builder.js";
import { SECTION_KEYS, type SectionKey } from "../types/domain.js";
import { formatDate, singleLine, truncate } from "../utils/text.js";
import { UNTRUSTED_NOTICE } from "./shared.js";

/** Compact, token-efficient search listing. Documents already shown in this session are reduced to one line. */
export function formatSearchResults(response: SearchResponse, alreadyShown: ReadonlySet<string>): string {
  const query = truncate(singleLine(response.query), 120);
  if (response.items.length === 0) {
    return `No stored knowledge matched "${neutralizeWrapperTags(query)}". Continue with the task normally; if you produce a reusable, verified result, save it with save_knowledge.`;
  }
  const lines = [
    UNTRUSTED_NOTICE,
    `<knowledge_search_results results="${response.items.length}" latency_ms="${Math.round(response.latencyMs)}"${response.cacheHit ? ' cache="hit"' : ""}>`,
  ];
  response.items.forEach((item, index) => {
    const header =
      `[${index + 1}] ${item.id} · v${item.version} · score ${item.ranking.score.toFixed(2)} (${item.ranking.confidence}) · ` +
      `${item.verificationStatus.replace("_", " ")} · ${item.visibility} · ns:${item.namespace} · updated ${formatDate(item.updatedAt)}` +
      (item.ranking.stale ? " · STALE" : "");
    const title = neutralizeWrapperTags(item.title);
    if (alreadyShown.has(item.id)) {
      lines.push(`${header}\n    ${title} (already shown in this session, unchanged)`);
      return;
    }
    const details = [
      `    ${title}`,
      item.tags.length > 0 ? `    tags: ${item.tags.join(", ")}` : null,
      `    why: ${item.ranking.reasons.join(", ") || "weak match"}`,
      item.feedback.helpful + item.feedback.outdated + item.feedback.incorrect > 0
        ? `    feedback: ${item.feedback.helpful} helpful, ${item.feedback.outdated} outdated, ${item.feedback.incorrect} incorrect`
        : null,
      `    summary: ${neutralizeWrapperTags(item.summary)}`,
      item.riskFlags.length > 0 ? `    WARNING flagged ${item.riskFlags.join(", ")}: read critically` : null,
    ].filter((line): line is string => line !== null);
    lines.push([header, ...details].join("\n"));
  });
  lines.push("</knowledge_search_results>");
  lines.push(
    "Reuse a result only if it fits this task and cite its knowledge_id. Use get_knowledge (optionally with sections) for details, then report the outcome with knowledge_feedback.",
  );
  return lines.join("\n");
}

export function formatDocumentView(
  view: DocumentView,
  options: { sections?: readonly SectionKey[] | undefined; maxChars?: number | undefined },
): string {
  const doc = view.document;
  const attributes = [
    `id="${doc.id}"`,
    `version="${view.version}"`,
    view.isLatest ? null : `latest_version="${doc.version}"`,
    `content_hash="${view.contentHash.slice(0, 16)}"`,
    `verification="${view.verificationStatus}"`,
    `visibility="${doc.visibility}"`,
    doc.status === "archived" ? `status="archived"` : null,
  ]
    .filter(Boolean)
    .join(" ");

  let body = view.contentMd;
  if (options.sections) {
    const keys = SECTION_KEYS.filter((key) => options.sections?.includes(key));
    body = `# ${singleLine(view.title)}\n\n${renderSections(view.sections, keys) || "(none of the requested sections exist in this document)"}`;
  }
  let truncation = "";
  if (options.maxChars && body.length > options.maxChars) {
    truncation = `\n[truncated: ${body.length - options.maxChars} more characters; request specific sections instead]`;
    body = body.slice(0, options.maxChars);
  }
  const history =
    view.history.length > 1
      ? `Recent versions: ${view.history.map((entry) => `v${entry.version} ${formatDate(entry.createdAt)} (${truncate(singleLine(entry.changeSummary), 60)})`).join("; ")}`
      : null;
  return [
    UNTRUSTED_NOTICE,
    doc.riskFlags.length > 0 ? `WARNING: flagged ${doc.riskFlags.join(", ")}. Read critically.` : null,
    `<knowledge_document ${attributes}>`,
    `${neutralizeWrapperTags(body)}${truncation}`,
    "</knowledge_document>",
    history,
    `Feedback: ${doc.feedback.helpful} helpful, ${doc.feedback.outdated} outdated, ${doc.feedback.incorrect} incorrect.`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatWriteNotes(notes: WriteNotes): string[] {
  const lines: string[] = [];
  const redactions = Object.entries(notes.redactions);
  if (redactions.length > 0) {
    lines.push(`Redacted before saving: ${redactions.map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`).join(", ")}.`);
  }
  for (const warning of notes.warnings) lines.push(`Note: ${warning}`);
  if (notes.riskFlags.length > 0) {
    lines.push(`Flagged for review (${notes.riskFlags.join(", ")}): readers will see a warning.`);
  }
  return lines;
}
