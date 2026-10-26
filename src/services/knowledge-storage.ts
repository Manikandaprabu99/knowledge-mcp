import { z } from "zod";
import type { Database } from "../database/client.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import type {
  DocumentListItem,
  DocumentRepository,
  ListFilters,
  VersionSummary,
} from "../database/repositories/document-repository.js";
import { redactSensitive } from "../security/redaction.js";
import { detectPromptInjection, sanitizeText } from "../security/sanitize.js";
import type {
  DocumentHeader,
  FeedbackOutcome,
  Identity,
  KnowledgeDocument,
  KnowledgeSections,
  OnDuplicate,
  VerificationStatus,
  Visibility,
} from "../types/domain.js";
import { AppError, isAppError } from "../utils/errors.js";
import { generateKnowledgeId, KNOWLEDGE_ID_PATTERN } from "../utils/ids.js";
import type { Logger } from "../utils/logger.js";
import { singleLine, titleKey } from "../utils/text.js";
import { canChangeVisibility, canDelete, canRead, canWrite, createDenialReason, type GrantPermission } from "./access-control.js";
import { computeFingerprint, type DuplicateCandidate, type DuplicateDetector } from "./deduplication.js";
import type { EmbeddingIndex } from "./embeddings.js";
import {
  buildKeywords,
  buildSummary,
  cleanContent,
  deriveVerification,
  mergeSections,
  normalizeCategory,
  normalizeTags,
  renderValidation,
  sourceClientLabel,
  type ContentFields,
  type MergeMode,
} from "./knowledge-content.js";
import { buildMarkdown, computeContentHash, exportFileName } from "./markdown-builder.js";
import { estimateEffortTokens } from "./token-estimator.js";
import type { MetricName, UsageMetrics } from "./usage-metrics.js";

export interface StorageConfig {
  namespace: string;
  defaultVisibility: Visibility;
  maxDocumentBytes: number;
  redactEmails: boolean;
}

export interface StorageDeps {
  db: Database;
  documents: DocumentRepository;
  audit: AuditRepository;
  duplicates: DuplicateDetector;
  metrics: UsageMetrics;
  logger: Logger;
  config: StorageConfig;
  embeddings: EmbeddingIndex | null;
  /** Called after every committed change (used to invalidate the search cache). */
  onChange: () => void;
}

export interface SaveInput extends ContentFields {
  title: string;
  problem: string;
  solution: string;
  namespace?: string | undefined;
  visibility?: Visibility | undefined;
  sourceClient?: string | undefined;
  sourceMetadata?: Record<string, string | number | boolean> | undefined;
  onDuplicate: OnDuplicate;
  measuredTokensUsed?: number | undefined;
}

export interface UpdateInput extends ContentFields {
  knowledgeId: string;
  expectedVersion: number;
  mode: MergeMode;
  changeSummary: string;
  visibility?: Visibility | undefined;
  sourceClient?: string | undefined;
}

export interface WriteNotes {
  redactions: Record<string, number>;
  warnings: string[];
  riskFlags: string[];
}

export type SaveResult =
  | ({ status: "created"; document: DocumentHeader } & WriteNotes)
  | ({ status: "duplicate"; existing: DuplicateCandidate } & WriteNotes)
  | ({ status: "possible_duplicate"; candidates: DuplicateCandidate[] } & WriteNotes)
  | ({ status: "merged"; document: DocumentHeader; changed: string[] } & WriteNotes);

export interface UpdateResult extends WriteNotes {
  document: DocumentHeader;
  previousVersion: number;
  changed: string[];
}

export interface DocumentView {
  document: KnowledgeDocument;
  version: number;
  isLatest: boolean;
  title: string;
  sections: KnowledgeSections;
  contentMd: string;
  contentHash: string;
  verificationStatus: VerificationStatus;
  history: VersionSummary[];
}

export interface FeedbackInput {
  knowledgeId: string;
  version?: number | undefined;
  outcome: FeedbackOutcome;
  comment?: string | undefined;
  measuredTokensSaved?: number | undefined;
}

export interface FeedbackResult {
  document: KnowledgeDocument;
  version: number;
  recorded: "new" | "updated";
  estimatedTokensAvoided: number;
}

const cursorSchema = z.object({ updatedAt: z.string().min(10).max(64), id: z.string().regex(KNOWLEDGE_ID_PATTERN) });

/** Business rules for writing and reading knowledge documents. All access checks happen here or in SQL. */
export class KnowledgeStorageService {
  constructor(private readonly deps: StorageDeps) {}

  async save(identity: Identity, input: SaveInput): Promise<SaveResult> {
    const visibility = input.visibility ?? this.deps.config.defaultVisibility;
    const denial = createDenialReason(identity, visibility);
    if (denial) throw new AppError("FORBIDDEN", denial);

    const cleaned = cleanContent(input, { redactEmails: this.deps.config.redactEmails });
    const title = cleaned.title ?? "";
    const problem = cleaned.sections.problem ?? "";
    const solution = cleaned.sections.solution ?? "";
    if (title.length < 3 || problem.length < 3 || solution.length < 3) {
      throw new AppError("VALIDATION_ERROR", "title, problem and solution must contain meaningful text after sanitization.");
    }
    const verification = deriveVerification(cleaned.validation);
    const sections: KnowledgeSections = { ...cleaned.sections, problem, solution };
    if (cleaned.validation) sections.validation = renderValidation(cleaned.validation, verification.status);
    const notes: WriteNotes = {
      redactions: cleaned.redactions,
      warnings: verification.warning ? [verification.warning] : [],
      riskFlags: cleaned.riskFlags,
    };
    const fingerprint = computeFingerprint(problem, solution);

    const duplicates = await this.deps.duplicates.findDuplicates(identity, { title, problem, fingerprint });
    const exact = duplicates.find((candidate) => candidate.exact);
    if (exact) {
      this.deps.metrics.increment(identity.orgId, "duplicates_avoided");
      return { status: "duplicate", existing: exact, ...notes };
    }
    const best = duplicates[0];
    if (best && input.onDuplicate === "return_existing") {
      this.deps.metrics.increment(identity.orgId, "duplicates_avoided");
      return { status: "possible_duplicate", candidates: duplicates.slice(0, 3), ...notes };
    }
    if (best && input.onDuplicate === "update_existing") {
      try {
        const merged = await this.update(identity, {
          ...input,
          visibility: undefined,
          knowledgeId: best.id,
          expectedVersion: best.version,
          mode: "merge",
          changeSummary: "Merged from save_knowledge after duplicate detection",
        });
        this.deps.metrics.increment(identity.orgId, "duplicates_avoided");
        return {
          status: "merged",
          document: merged.document,
          changed: merged.changed,
          redactions: merged.redactions,
          riskFlags: merged.riskFlags,
          warnings: [...notes.warnings, ...merged.warnings],
        };
      } catch (error) {
        if (!isAppError(error, "FORBIDDEN") && !isAppError(error, "VALIDATION_ERROR")) throw error;
        notes.warnings.push(`Could not merge into ${best.id}: ${error.message}`);
        return { status: "possible_duplicate", candidates: duplicates.slice(0, 3), ...notes };
      }
    }

    const now = new Date();
    const id = generateKnowledgeId(now.getTime());
    const namespace = input.namespace ?? this.deps.config.namespace;
    const tags = cleaned.tags ?? [];
    const category = cleaned.category ?? normalizeCategory(undefined);
    const sourceClient = sourceClientLabel(input.sourceClient);
    const contentMd = buildMarkdown(
      {
        knowledgeId: id,
        title,
        category,
        tags,
        namespace,
        createdAt: now,
        updatedAt: now,
        createdBy: identity.userId,
        visibility,
        sourceClient,
        version: 1,
        verificationStatus: verification.status,
      },
      sections,
    );
    this.assertSize(contentMd);
    const contentHash = computeContentHash(title, sections, tags, verification.status);

    const raced = await this.deps.db.transaction(async (tx) => {
      // Serializes concurrent saves of identical content, then re-checks for an exact duplicate.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`knowledge:${fingerprint}`]);
      const existing = await this.deps.documents.findExactDuplicate(identity, fingerprint, tx);
      if (existing) return existing;
      await this.deps.documents.insertDocument(
        {
          id,
          orgId: identity.orgId,
          namespace,
          ownerId: identity.userId,
          title,
          slug: titleKey(title),
          category,
          visibility,
          verificationStatus: verification.status,
          summary: buildSummary(sections, cleaned.summary),
          keywords: buildKeywords(tags),
          sections,
          contentMd,
          contentHash,
          fingerprint,
          riskFlags: cleaned.riskFlags,
          sourceClient,
          sourceMetadata: this.cleanSourceMetadata(input.sourceMetadata),
          estimatedEffortTokens: estimateEffortTokens(contentMd),
          measuredEffortTokens: input.measuredTokensUsed ?? null,
          now,
        },
        tx,
      );
      await this.deps.documents.insertVersion(
        {
          documentId: id,
          version: 1,
          title,
          sections,
          contentMd,
          contentHash,
          verificationStatus: verification.status,
          changeSummary: "Created",
          changedBy: identity.userId,
          sourceClient,
          createdAt: now,
        },
        tx,
      );
      await this.deps.documents.replaceTags(id, tags, tx);
      await this.deps.audit.record(
        {
          actorId: identity.userId,
          action: "knowledge.created",
          documentId: id,
          details: { version: 1, visibility, namespace, redactions: cleaned.redactions, riskFlags: cleaned.riskFlags },
        },
        tx,
      );
      return null;
    });
    if (raced) {
      this.deps.metrics.increment(identity.orgId, "duplicates_avoided");
      return { status: "duplicate", existing: { ...raced, score: 1 }, ...notes };
    }

    this.afterWrite(identity, "documents_saved", { id, title, sections, contentHash });
    return {
      status: "created",
      document: { id, title, version: 1, namespace, category, visibility, verificationStatus: verification.status, contentHash, tags, updatedAt: now },
      ...notes,
    };
  }

  async update(identity: Identity, input: UpdateInput): Promise<UpdateResult> {
    const cleaned = cleanContent(input, { redactEmails: this.deps.config.redactEmails });
    const changeSummary = this.cleanLine(input.changeSummary, 500) || "Updated";

    const outcome = await this.deps.db.transaction(async (tx) => {
      const doc = await this.deps.documents.findByIdForUpdate(input.knowledgeId, tx);
      const grant = doc ? await this.grantFor(identity, doc, tx) : null;
      if (!doc || doc.status !== "active" || !canRead(identity, doc, grant)) throw notFound(input.knowledgeId);
      if (!canWrite(identity, doc, grant)) {
        throw new AppError(
          "FORBIDDEN",
          "You can read this document but not modify it. Report problems with knowledge_feedback, or save your own version with save_knowledge.",
        );
      }
      if (doc.version !== input.expectedVersion) {
        throw new AppError(
          "CONFLICT",
          `Version conflict: expected_version=${input.expectedVersion}, but the document is at version ${doc.version} ` +
            `(updated ${doc.updatedAt.toISOString()}). Call get_knowledge to read the latest version, merge your changes, ` +
            `and retry with expected_version=${doc.version}.`,
          { currentVersion: doc.version },
        );
      }
      const visibility = input.visibility ?? doc.visibility;
      if (visibility !== doc.visibility) {
        const reason = canChangeVisibility(identity, doc, visibility);
        if (reason) throw new AppError("FORBIDDEN", reason);
      }

      const { sections, changed } = mergeSections(doc.sections, cleaned.sections, input.mode);
      const warnings: string[] = [];
      let verificationStatus = doc.verificationStatus;
      if (cleaned.validation) {
        const derived = deriveVerification(cleaned.validation);
        verificationStatus = derived.status;
        if (derived.warning) warnings.push(derived.warning);
        const rendered = renderValidation(cleaned.validation, derived.status);
        const next = input.mode === "merge" && doc.sections.validation ? `${doc.sections.validation}\n\n${rendered}` : rendered;
        if (next !== doc.sections.validation) {
          sections.validation = next;
          changed.push("validation");
        }
      } else if ((changed.includes("solution") || changed.includes("implementation")) && doc.verificationStatus !== "unverified") {
        verificationStatus = "unverified";
        warnings.push("Verification was reset to unverified because the solution changed; include validation evidence to mark it verified again.");
      }

      const title = cleaned.title || doc.title;
      const category = cleaned.category ?? doc.category;
      const tags =
        cleaned.tags === undefined
          ? doc.tags
          : input.mode === "merge"
            ? normalizeTags([...doc.tags, ...cleaned.tags])
            : cleaned.tags;
      const metadataChanges = [
        title !== doc.title ? "title" : null,
        category !== doc.category ? "category" : null,
        visibility !== doc.visibility ? "visibility" : null,
        tags.join(",") !== doc.tags.join(",") ? "tags" : null,
        verificationStatus !== doc.verificationStatus ? "verification_status" : null,
      ].filter((change): change is string => change !== null);
      const allChanges = [...new Set<string>([...changed, ...metadataChanges])];
      if (allChanges.length === 0) throw new AppError("VALIDATION_ERROR", "No changes: the update matches the current version.");
      if (!sections.problem.trim() || !sections.solution.trim()) {
        throw new AppError("VALIDATION_ERROR", "problem and solution cannot be empty.");
      }

      const now = new Date();
      const version = doc.version + 1;
      const contentMd = buildMarkdown(
        {
          knowledgeId: doc.id,
          title,
          category,
          tags,
          namespace: doc.namespace,
          createdAt: doc.createdAt,
          updatedAt: now,
          createdBy: doc.ownerId,
          visibility,
          sourceClient: doc.sourceClient,
          version,
          verificationStatus,
        },
        sections,
      );
      this.assertSize(contentMd);
      const contentHash = computeContentHash(title, sections, tags, verificationStatus);
      const summary =
        cleaned.summary ?? (changed.includes("problem") || changed.includes("solution") ? buildSummary(sections) : doc.summary);
      const stored = await this.deps.documents.updateDocument(
        doc.id,
        input.expectedVersion,
        {
          title,
          slug: titleKey(title),
          category,
          visibility,
          verificationStatus,
          summary,
          keywords: buildKeywords(tags),
          sections,
          contentMd,
          contentHash,
          fingerprint: computeFingerprint(sections.problem, sections.solution),
          riskFlags: detectPromptInjection([title, ...Object.values(sections)].join("\n")),
          estimatedEffortTokens: Math.max(doc.estimatedEffortTokens, estimateEffortTokens(contentMd)),
          now,
        },
        tx,
      );
      if (stored === null) throw new AppError("CONFLICT", "The document changed while it was being updated; read it again and retry.");
      await this.deps.documents.insertVersion(
        {
          documentId: doc.id,
          version,
          title,
          sections,
          contentMd,
          contentHash,
          verificationStatus,
          changeSummary,
          changedBy: identity.userId,
          sourceClient: sourceClientLabel(input.sourceClient),
          createdAt: now,
        },
        tx,
      );
      if (cleaned.tags !== undefined) await this.deps.documents.replaceTags(doc.id, tags, tx);
      await this.deps.documents.refreshFeedbackCounts(doc.id, tx);
      await this.deps.audit.record(
        {
          actorId: identity.userId,
          action: "knowledge.updated",
          documentId: doc.id,
          details: { fromVersion: doc.version, toVersion: version, changed: allChanges, mode: input.mode, redactions: cleaned.redactions },
        },
        tx,
      );
      const header: DocumentHeader = {
        id: doc.id,
        title,
        version,
        namespace: doc.namespace,
        category,
        visibility,
        verificationStatus,
        contentHash,
        tags,
        updatedAt: now,
      };
      return { header, sections, previousVersion: doc.version, changed: allChanges, warnings };
    });

    this.afterWrite(identity, "documents_updated", {
      id: outcome.header.id,
      title: outcome.header.title,
      sections: outcome.sections,
      contentHash: outcome.header.contentHash,
    });
    return {
      document: outcome.header,
      previousVersion: outcome.previousVersion,
      changed: outcome.changed,
      redactions: cleaned.redactions,
      warnings: outcome.warnings,
      riskFlags: cleaned.riskFlags,
    };
  }

  /** Loads a readable document (optionally a historical version). Archived documents are visible only to those who may delete them. */
  async get(
    identity: Identity,
    knowledgeId: string,
    options: { version?: number | undefined; recordRetrieval?: boolean } = {},
  ): Promise<DocumentView> {
    const doc = await this.loadReadable(identity, knowledgeId);
    const history = await this.deps.documents.listVersions(doc.id, 5);
    let view: DocumentView = {
      document: doc,
      version: doc.version,
      isLatest: true,
      title: doc.title,
      sections: doc.sections,
      contentMd: doc.contentMd,
      contentHash: doc.contentHash,
      verificationStatus: doc.verificationStatus,
      history,
    };
    if (options.version !== undefined && options.version !== doc.version) {
      const snapshot = await this.deps.documents.getVersion(doc.id, options.version);
      if (!snapshot) {
        throw new AppError("NOT_FOUND", `Version ${options.version} of ${doc.id} does not exist (latest is ${doc.version}).`);
      }
      view = { ...view, ...snapshot, isLatest: false };
    }
    if (options.recordRetrieval !== false) {
      this.deps.metrics.increment(identity.orgId, "documents_retrieved");
      this.deps.documents
        .recordRetrieval(doc.id)
        .catch((error: unknown) => this.deps.logger.debug("Could not record retrieval", { documentId: doc.id, error }));
    }
    return view;
  }

  async list(
    identity: Identity,
    filters: ListFilters,
    limit: number,
    cursor: string | undefined,
  ): Promise<{ items: DocumentListItem[]; nextCursor: string | null }> {
    const page = await this.deps.documents.list(identity, filters, limit, cursor ? decodeCursor(cursor) : null);
    return {
      items: page.items,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64url") : null,
    };
  }

  async export(
    identity: Identity,
    knowledgeId: string,
    version?: number,
  ): Promise<{ fileName: string; markdown: string; contentHash: string; version: number; title: string }> {
    const view = await this.get(identity, knowledgeId, { version });
    return {
      fileName: exportFileName(view.title, view.document.id),
      markdown: view.contentMd,
      contentHash: view.contentHash,
      version: view.version,
      title: view.title,
    };
  }

  async remove(
    identity: Identity,
    knowledgeId: string,
    mode: "archive" | "delete",
    reason?: string,
  ): Promise<{ status: "archived" | "deleted" | "already_archived"; title: string }> {
    const outcome = await this.deps.db.transaction(async (tx) => {
      const doc = await this.deps.documents.findByIdForUpdate(knowledgeId, tx);
      const grant = doc ? await this.grantFor(identity, doc, tx) : null;
      if (!doc || !canRead(identity, doc, grant)) throw notFound(knowledgeId);
      if (!canDelete(identity, doc)) {
        throw new AppError("FORBIDDEN", "Only the owner (or an org admin for shared/public documents) can archive or delete this document.");
      }
      if (mode === "archive" && doc.status === "archived") return { status: "already_archived" as const, title: doc.title };
      if (mode === "archive") await this.deps.documents.archive(doc.id, tx);
      else await this.deps.documents.hardDelete(doc.id, tx);
      await this.deps.audit.record(
        {
          actorId: identity.userId,
          action: mode === "archive" ? "knowledge.archived" : "knowledge.deleted",
          documentId: doc.id,
          details: { version: doc.version, visibility: doc.visibility, reason: reason ? this.cleanLine(reason, 300) : null },
        },
        tx,
      );
      return { status: mode === "archive" ? ("archived" as const) : ("deleted" as const), title: doc.title };
    });
    if (outcome.status !== "already_archived") this.deps.onChange();
    return outcome;
  }

  async feedback(identity: Identity, input: FeedbackInput): Promise<FeedbackResult> {
    const doc = await this.loadReadable(identity, input.knowledgeId);
    const version = input.version ?? doc.version;
    if (version < 1 || version > doc.version) {
      throw new AppError("VALIDATION_ERROR", `version must be between 1 and ${doc.version}.`);
    }
    const { inserted } = await this.deps.db.transaction(async (tx) => {
      const result = await this.deps.documents.upsertFeedback(
        {
          documentId: doc.id,
          version,
          userId: identity.userId,
          outcome: input.outcome,
          comment: input.comment ? this.cleanLine(input.comment, 1_000) : null,
          measuredTokensSaved: input.measuredTokensSaved ?? null,
        },
        tx,
      );
      await this.deps.documents.refreshFeedbackCounts(doc.id, tx);
      await this.deps.audit.record(
        { actorId: identity.userId, action: "knowledge.feedback", documentId: doc.id, details: { version, outcome: input.outcome } },
        tx,
      );
      return result;
    });

    let estimatedTokensAvoided = 0;
    if (inserted) {
      const reused = input.outcome === "solved" || input.outcome === "partially_solved";
      if (reused) {
        estimatedTokensAvoided = Math.round(doc.estimatedEffortTokens * (input.outcome === "solved" ? 1 : 0.5));
        this.deps.metrics.increment(identity.orgId, "feedback_reuse");
        this.deps.metrics.increment(identity.orgId, "estimated_tokens_avoided", estimatedTokensAvoided);
        if (input.measuredTokensSaved) this.deps.metrics.increment(identity.orgId, "measured_tokens_saved", input.measuredTokensSaved);
      } else {
        this.deps.metrics.increment(identity.orgId, "feedback_negative");
      }
    }
    this.deps.onChange();
    return { document: doc, version, recorded: inserted ? "new" : "updated", estimatedTokensAvoided };
  }

  private async loadReadable(identity: Identity, knowledgeId: string): Promise<KnowledgeDocument> {
    const doc = await this.deps.documents.findById(knowledgeId);
    if (!doc) throw notFound(knowledgeId);
    const grant = await this.grantFor(identity, doc);
    if (!canRead(identity, doc, grant)) throw notFound(knowledgeId);
    if (doc.status === "archived" && !canDelete(identity, doc)) throw notFound(knowledgeId);
    return doc;
  }

  private async grantFor(
    identity: Identity,
    doc: KnowledgeDocument,
    q?: Parameters<DocumentRepository["getGrant"]>[2],
  ): Promise<GrantPermission | null> {
    if (doc.ownerId === identity.userId) return null;
    return this.deps.documents.getGrant(doc.id, identity.userId, q);
  }

  private afterWrite(
    identity: Identity,
    metric: MetricName,
    doc: { id: string; title: string; sections: KnowledgeSections; contentHash: string },
  ): void {
    this.deps.onChange();
    this.deps.metrics.increment(identity.orgId, metric);
    if (this.deps.embeddings) void this.deps.embeddings.indexDocument(doc);
  }

  private assertSize(contentMd: string): void {
    const bytes = Buffer.byteLength(contentMd, "utf8");
    if (bytes > this.deps.config.maxDocumentBytes) {
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        `The document is ${bytes} bytes; the limit is ${this.deps.config.maxDocumentBytes}. Store a concise, reusable summary instead of full logs or conversations.`,
      );
    }
  }

  private cleanLine(value: string, maxLength: number): string {
    return singleLine(redactSensitive(sanitizeText(value), { redactEmails: this.deps.config.redactEmails }).text).slice(0, maxLength);
  }

  private cleanSourceMetadata(
    metadata: Record<string, string | number | boolean> | undefined,
  ): Record<string, string | number | boolean> {
    const output: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(metadata ?? {}).slice(0, 10)) {
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
      output[key] = typeof value === "string" ? this.cleanLine(value, 200) : value;
    }
    return output;
  }
}

function notFound(knowledgeId: string): AppError {
  // Same message whether the document is missing or not readable, so ids cannot be probed.
  return new AppError("NOT_FOUND", `No accessible knowledge document with id ${knowledgeId}.`);
}

function decodeCursor(token: string): { updatedAt: string; id: string } {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid cursor; pass the next_cursor value from a previous list_knowledge call.");
  }
}
