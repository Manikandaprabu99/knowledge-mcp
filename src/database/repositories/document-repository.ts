import type { QueryResultRow } from "pg";
import { readablePredicate, type GrantPermission } from "../../services/access-control.js";
import type {
  DocumentStatus,
  FeedbackOutcome,
  Identity,
  KnowledgeDocument,
  KnowledgeSections,
  VerificationStatus,
  Visibility,
} from "../../types/domain.js";
import { SqlParams } from "../../utils/sql.js";
import type { Queryable } from "../client.js";

const DOCUMENT_COLUMNS = `
  d.id, d.org_id, d.namespace, d.owner_id, d.title, d.slug, d.category, d.visibility, d.status,
  d.verification_status, d.version, d.summary, d.sections, d.content_md, d.content_hash, d.fingerprint,
  d.risk_flags, d.source_client, d.estimated_effort_tokens, d.measured_effort_tokens,
  d.created_at, d.updated_at, d.archived_at,
  ARRAY(SELECT t.tag FROM document_tags t WHERE t.document_id = d.id ORDER BY t.tag) AS tags,
  COALESCE(s.helpful_count, 0) AS helpful_count,
  COALESCE(s.outdated_count, 0) AS outdated_count,
  COALESCE(s.incorrect_count, 0) AS incorrect_count,
  COALESCE(s.irrelevant_count, 0) AS irrelevant_count,
  COALESCE(s.retrieval_count, 0) AS retrieval_count`;

const DOCUMENT_FROM = "knowledge_documents d LEFT JOIN document_stats s ON s.document_id = d.id";

export interface NewDocumentRow {
  id: string;
  orgId: string;
  namespace: string;
  ownerId: string;
  title: string;
  slug: string;
  category: string;
  visibility: Visibility;
  verificationStatus: VerificationStatus;
  summary: string;
  keywords: string;
  sections: KnowledgeSections;
  contentMd: string;
  contentHash: string;
  fingerprint: string;
  riskFlags: string[];
  sourceClient: string | null;
  sourceMetadata: Record<string, string | number | boolean>;
  estimatedEffortTokens: number;
  measuredEffortTokens: number | null;
  now: Date;
}

export type DocumentUpdateRow = Omit<
  NewDocumentRow,
  "id" | "orgId" | "namespace" | "ownerId" | "sourceClient" | "sourceMetadata" | "measuredEffortTokens"
>;

export interface VersionRow {
  documentId: string;
  version: number;
  title: string;
  sections: KnowledgeSections;
  contentMd: string;
  contentHash: string;
  verificationStatus: VerificationStatus;
  changeSummary: string;
  changedBy: string;
  sourceClient: string | null;
  createdAt: Date;
}

export type DocumentVersion = Omit<VersionRow, "documentId" | "sourceClient">;

export interface VersionSummary {
  version: number;
  changeSummary: string;
  changedBy: string;
  createdAt: Date;
}

export interface DuplicateRow {
  id: string;
  title: string;
  version: number;
  namespace: string;
  visibility: Visibility;
  ownerId: string;
  updatedAt: Date;
  exact: boolean;
  titleSimilarity: number;
  problemSimilarity: number;
}

export interface DuplicateProbe {
  fingerprint: string;
  slug: string;
  title: string;
  problemExcerpt: string;
  tsQuery: string | null;
}

export interface ListFilters {
  namespace?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  ownerId?: string | undefined;
  visibility?: Visibility | undefined;
  updatedAfter?: Date | undefined;
  updatedBefore?: Date | undefined;
  includeArchived: boolean;
}

export interface ListCursor {
  updatedAt: string;
  id: string;
}

export interface DocumentListItem {
  id: string;
  title: string;
  namespace: string;
  category: string;
  visibility: Visibility;
  status: DocumentStatus;
  version: number;
  verificationStatus: VerificationStatus;
  ownerId: string;
  updatedAt: Date;
  summary: string;
  tags: string[];
}

export interface FeedbackEntry {
  documentId: string;
  version: number;
  userId: string;
  outcome: FeedbackOutcome;
  comment: string | null;
  measuredTokensSaved: number | null;
}

interface DocumentRow extends QueryResultRow {
  id: string;
  org_id: string;
  namespace: string;
  owner_id: string;
  title: string;
  slug: string;
  category: string;
  visibility: Visibility;
  status: DocumentStatus;
  verification_status: VerificationStatus;
  version: number;
  summary: string;
  sections: KnowledgeSections;
  content_md: string;
  content_hash: string;
  fingerprint: string;
  risk_flags: string[];
  source_client: string | null;
  estimated_effort_tokens: number;
  measured_effort_tokens: number | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  tags: string[];
  helpful_count: number;
  outdated_count: number;
  incorrect_count: number;
  irrelevant_count: number;
  retrieval_count: number;
}

interface DuplicateDbRow extends QueryResultRow {
  id: string;
  title: string;
  version: number;
  namespace: string;
  visibility: Visibility;
  owner_id: string;
  updated_at: Date;
  exact: boolean;
  title_similarity: number;
  problem_similarity: number;
}

interface ListRow extends QueryResultRow {
  id: string;
  title: string;
  namespace: string;
  category: string;
  visibility: Visibility;
  status: DocumentStatus;
  version: number;
  verification_status: VerificationStatus;
  owner_id: string;
  updated_at: Date;
  cursor_ts: string;
  summary: string;
  tags: string[];
}

interface VersionDbRow extends QueryResultRow {
  version: number;
  title: string;
  sections: KnowledgeSections;
  content_md: string;
  content_hash: string;
  verification_status: VerificationStatus;
  change_summary: string;
  changed_by: string;
  created_at: Date;
}

/** All SQL for knowledge documents, versions, tags, grants, stats and feedback. */
export class DocumentRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string, q: Queryable = this.db): Promise<KnowledgeDocument | null> {
    const result = await q.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapDocument(row) : null;
  }

  /** Locks the document row for the rest of the transaction. */
  async findByIdForUpdate(id: string, q: Queryable): Promise<KnowledgeDocument | null> {
    const result = await q.query<DocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM ${DOCUMENT_FROM} WHERE d.id = $1 FOR UPDATE OF d`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapDocument(row) : null;
  }

  async getGrant(documentId: string, userId: string, q: Queryable = this.db): Promise<GrantPermission | null> {
    const result = await q.query<{ permission: GrantPermission }>(
      "SELECT permission FROM document_grants WHERE document_id = $1 AND grantee_id = $2",
      [documentId, userId],
    );
    return result.rows[0]?.permission ?? null;
  }

  async insertDocument(row: NewDocumentRow, q: Queryable): Promise<void> {
    await q.query(
      `INSERT INTO knowledge_documents (
         id, org_id, namespace, owner_id, title, slug, category, visibility, verification_status, version,
         summary, keywords, sections, content_md, content_hash, fingerprint, risk_flags, source_client,
         source_metadata, estimated_effort_tokens, measured_effort_tokens, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12::jsonb, $13, $14, $15, $16::text[], $17,
               $18::jsonb, $19, $20, $21, $21)`,
      [
        row.id,
        row.orgId,
        row.namespace,
        row.ownerId,
        row.title,
        row.slug,
        row.category,
        row.visibility,
        row.verificationStatus,
        row.summary,
        row.keywords,
        JSON.stringify(row.sections),
        row.contentMd,
        row.contentHash,
        row.fingerprint,
        row.riskFlags,
        row.sourceClient,
        JSON.stringify(row.sourceMetadata),
        row.estimatedEffortTokens,
        row.measuredEffortTokens,
        row.now,
      ],
    );
    await q.query("INSERT INTO document_stats (document_id) VALUES ($1)", [row.id]);
  }

  /** Optimistic update: succeeds only if the stored version still equals expectedVersion. Returns the new version. */
  async updateDocument(id: string, expectedVersion: number, row: DocumentUpdateRow, q: Queryable): Promise<number | null> {
    const result = await q.query<{ version: number }>(
      `UPDATE knowledge_documents SET
         title = $3, slug = $4, category = $5, visibility = $6, verification_status = $7, summary = $8,
         keywords = $9, sections = $10::jsonb, content_md = $11, content_hash = $12, fingerprint = $13,
         risk_flags = $14::text[], estimated_effort_tokens = $15, version = version + 1, updated_at = $16
       WHERE id = $1 AND version = $2 AND status = 'active'
       RETURNING version`,
      [
        id,
        expectedVersion,
        row.title,
        row.slug,
        row.category,
        row.visibility,
        row.verificationStatus,
        row.summary,
        row.keywords,
        JSON.stringify(row.sections),
        row.contentMd,
        row.contentHash,
        row.fingerprint,
        row.riskFlags,
        row.estimatedEffortTokens,
        row.now,
      ],
    );
    return result.rows[0]?.version ?? null;
  }

  async insertVersion(row: VersionRow, q: Queryable): Promise<void> {
    await q.query(
      `INSERT INTO knowledge_versions (document_id, version, title, sections, content_md, content_hash,
         verification_status, change_summary, changed_by, source_client, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.documentId,
        row.version,
        row.title,
        JSON.stringify(row.sections),
        row.contentMd,
        row.contentHash,
        row.verificationStatus,
        row.changeSummary,
        row.changedBy,
        row.sourceClient,
        row.createdAt,
      ],
    );
  }

  async replaceTags(documentId: string, tags: readonly string[], q: Queryable): Promise<void> {
    await q.query("DELETE FROM document_tags WHERE document_id = $1", [documentId]);
    if (tags.length === 0) return;
    await q.query(
      `INSERT INTO document_tags (document_id, tag)
       SELECT $1::text, tag FROM unnest($2::text[]) AS tag
       ON CONFLICT DO NOTHING`,
      [documentId, [...tags]],
    );
  }

  async getVersion(documentId: string, version: number, q: Queryable = this.db): Promise<DocumentVersion | null> {
    const result = await q.query<VersionDbRow>(
      `SELECT version, title, sections, content_md, content_hash, verification_status, change_summary, changed_by, created_at
       FROM knowledge_versions WHERE document_id = $1 AND version = $2`,
      [documentId, version],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      version: row.version,
      title: row.title,
      sections: row.sections,
      contentMd: row.content_md,
      contentHash: row.content_hash,
      verificationStatus: row.verification_status,
      changeSummary: row.change_summary,
      changedBy: row.changed_by,
      createdAt: row.created_at,
    };
  }

  async listVersions(documentId: string, limit = 10, q: Queryable = this.db): Promise<VersionSummary[]> {
    const result = await q.query<{ version: number; change_summary: string; changed_by: string; created_at: Date }>(
      `SELECT version, change_summary, changed_by, created_at FROM knowledge_versions
       WHERE document_id = $1 ORDER BY version DESC LIMIT $2::int`,
      [documentId, limit],
    );
    return result.rows.map((row) => ({
      version: row.version,
      changeSummary: row.change_summary,
      changedBy: row.changed_by,
      createdAt: row.created_at,
    }));
  }

  /** Exact duplicate (same normalized problem + solution) among documents the identity can read. */
  async findExactDuplicate(identity: Identity, fingerprint: string, q: Queryable = this.db): Promise<DuplicateRow | null> {
    const params = new SqlParams();
    const readable = readablePredicate("d", identity, params);
    const fp = params.add(fingerprint);
    const result = await q.query<DuplicateDbRow>(
      `SELECT d.id, d.title, d.version, d.namespace, d.visibility, d.owner_id, d.updated_at,
              TRUE AS exact, 1::float8 AS title_similarity, 1::float8 AS problem_similarity
       FROM knowledge_documents d
       WHERE d.status = 'active' AND d.fingerprint = ${fp}::text AND ${readable}
       ORDER BY d.updated_at DESC LIMIT 1`,
      params.values,
    );
    const row = result.rows[0];
    return row ? mapDuplicate(row) : null;
  }

  /** Near-duplicate candidates (fingerprint, title key, trigram title, full-text) among readable documents. */
  async findDuplicateCandidates(identity: Identity, probe: DuplicateProbe, q: Queryable = this.db): Promise<DuplicateRow[]> {
    const params = new SqlParams();
    const base = `d.status = 'active' AND ${readablePredicate("d", identity, params)}`;
    const fp = params.add(probe.fingerprint);
    const slug = params.add(probe.slug);
    const title = params.add(probe.title);
    const problem = params.add(probe.problemExcerpt);
    const tsq = params.add(probe.tsQuery);
    const result = await q.query<DuplicateDbRow>(
      `WITH candidates AS (
         (SELECT d.id FROM knowledge_documents d
           WHERE ${base} AND (d.fingerprint = ${fp}::text OR d.slug = ${slug}::text) LIMIT 10)
         UNION
         (SELECT d.id FROM knowledge_documents d
           WHERE ${base} AND d.title % ${title}::text
           ORDER BY similarity(d.title, ${title}::text) DESC LIMIT 20)
         UNION
         (SELECT d.id FROM knowledge_documents d
           WHERE ${base} AND ${tsq}::text IS NOT NULL AND d.search_vector @@ to_tsquery('english', ${tsq}::text)
           ORDER BY ts_rank_cd(d.search_vector, to_tsquery('english', ${tsq}::text)) DESC LIMIT 20)
       )
       SELECT d.id, d.title, d.version, d.namespace, d.visibility, d.owner_id, d.updated_at,
              (d.fingerprint = ${fp}::text) AS exact,
              similarity(d.title, ${title}::text)::float8 AS title_similarity,
              similarity(left(coalesce(d.sections ->> 'problem', ''), 1000), ${problem}::text)::float8 AS problem_similarity
       FROM candidates c JOIN knowledge_documents d ON d.id = c.id
       ORDER BY exact DESC, title_similarity DESC
       LIMIT 10`,
      params.values,
    );
    return result.rows.map(mapDuplicate);
  }

  /** Keyset-paginated listing (newest first) of documents the identity can read. */
  async list(
    identity: Identity,
    filters: ListFilters,
    limit: number,
    cursor: ListCursor | null,
    q: Queryable = this.db,
  ): Promise<{ items: DocumentListItem[]; nextCursor: ListCursor | null }> {
    const params = new SqlParams();
    const where = [readablePredicate("d", identity, params)];
    where.push(filters.includeArchived ? "d.status IN ('active', 'archived')" : "d.status = 'active'");
    if (filters.namespace) where.push(`d.namespace = ${params.add(filters.namespace)}::text`);
    if (filters.category) where.push(`d.category = ${params.add(filters.category)}::text`);
    if (filters.ownerId) where.push(`d.owner_id = ${params.add(filters.ownerId)}::text`);
    if (filters.visibility) where.push(`d.visibility = ${params.add(filters.visibility)}::text`);
    if (filters.updatedAfter) where.push(`d.updated_at >= ${params.add(filters.updatedAfter)}::timestamptz`);
    if (filters.updatedBefore) where.push(`d.updated_at < ${params.add(filters.updatedBefore)}::timestamptz`);
    if (filters.tags && filters.tags.length > 0) {
      where.push(
        `(SELECT count(*) FROM document_tags ft WHERE ft.document_id = d.id AND ft.tag = ANY(${params.add(filters.tags)}::text[])) = ${params.add(filters.tags.length)}::int`,
      );
    }
    if (cursor) {
      where.push(`(d.updated_at, d.id) < (${params.add(cursor.updatedAt)}::timestamptz, ${params.add(cursor.id)}::text)`);
    }
    const limitParam = params.add(limit + 1);
    const result = await q.query<ListRow>(
      `SELECT d.id, d.title, d.namespace, d.category, d.visibility, d.status, d.version, d.verification_status,
              d.owner_id, d.updated_at, d.updated_at::text AS cursor_ts, d.summary,
              ARRAY(SELECT t.tag FROM document_tags t WHERE t.document_id = d.id ORDER BY t.tag) AS tags
       FROM knowledge_documents d
       WHERE ${where.join(" AND ")}
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT ${limitParam}::int`,
      params.values,
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        namespace: row.namespace,
        category: row.category,
        visibility: row.visibility,
        status: row.status,
        version: row.version,
        verificationStatus: row.verification_status,
        ownerId: row.owner_id,
        updatedAt: row.updated_at,
        summary: row.summary,
        tags: row.tags,
      })),
      nextCursor: result.rows.length > limit && last ? { updatedAt: last.cursor_ts, id: last.id } : null,
    };
  }

  async archive(id: string, q: Queryable): Promise<boolean> {
    const result = await q.query(
      "UPDATE knowledge_documents SET status = 'archived', archived_at = now() WHERE id = $1 AND status = 'active'",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hardDelete(id: string, q: Queryable): Promise<boolean> {
    const result = await q.query("DELETE FROM knowledge_documents WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Retention: permanently removes documents archived more than `days` days ago. */
  async purgeArchived(days: number, q: Queryable = this.db): Promise<string[]> {
    const result = await q.query<{ id: string }>(
      `DELETE FROM knowledge_documents
       WHERE status = 'archived' AND archived_at < now() - make_interval(days => $1::int)
       RETURNING id`,
      [days],
    );
    return result.rows.map((row) => row.id);
  }

  async recordRetrieval(id: string, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO document_stats (document_id, retrieval_count, last_retrieved_at) VALUES ($1, 1, now())
       ON CONFLICT (document_id) DO UPDATE
         SET retrieval_count = document_stats.retrieval_count + 1, last_retrieved_at = now()`,
      [id],
    );
  }

  /** One feedback entry per user and document version; repeat calls update it. */
  async upsertFeedback(entry: FeedbackEntry, q: Queryable): Promise<{ inserted: boolean }> {
    const result = await q.query<{ inserted: boolean }>(
      `INSERT INTO knowledge_feedback (document_id, version, user_id, outcome, comment, measured_tokens_saved)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id, version, user_id) DO UPDATE
         SET outcome = EXCLUDED.outcome, comment = EXCLUDED.comment,
             measured_tokens_saved = EXCLUDED.measured_tokens_saved, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [entry.documentId, entry.version, entry.userId, entry.outcome, entry.comment, entry.measuredTokensSaved],
    );
    return { inserted: result.rows[0]?.inserted === true };
  }

  /**
   * Recomputes ranking counters. Helpful/irrelevant votes count across versions;
   * outdated/incorrect reports count only for the current version, so an update clears them.
   */
  async refreshFeedbackCounts(documentId: string, q: Queryable): Promise<void> {
    await q.query(
      `INSERT INTO document_stats (document_id, helpful_count, outdated_count, incorrect_count, irrelevant_count)
       SELECT d.id,
              count(f.document_id) FILTER (WHERE f.outcome IN ('solved', 'partially_solved')),
              count(f.document_id) FILTER (WHERE f.outcome = 'outdated' AND f.version = d.version),
              count(f.document_id) FILTER (WHERE f.outcome = 'incorrect' AND f.version = d.version),
              count(f.document_id) FILTER (WHERE f.outcome = 'irrelevant')
       FROM knowledge_documents d
       LEFT JOIN knowledge_feedback f ON f.document_id = d.id
       WHERE d.id = $1
       GROUP BY d.id
       ON CONFLICT (document_id) DO UPDATE SET
         helpful_count = EXCLUDED.helpful_count,
         outdated_count = EXCLUDED.outdated_count,
         incorrect_count = EXCLUDED.incorrect_count,
         irrelevant_count = EXCLUDED.irrelevant_count`,
      [documentId],
    );
  }

  async addGrant(documentId: string, granteeId: string, permission: GrantPermission, grantedBy: string): Promise<void> {
    await this.db.query(
      `INSERT INTO document_grants (document_id, grantee_id, permission, granted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, grantee_id) DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by`,
      [documentId, granteeId, permission, grantedBy],
    );
  }

  async removeGrant(documentId: string, granteeId: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM document_grants WHERE document_id = $1 AND grantee_id = $2", [
      documentId,
      granteeId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Operator helper (demo cleanup): removes every document of one namespace in one organization. */
  async deleteNamespace(orgId: string, namespace: string): Promise<number> {
    const result = await this.db.query("DELETE FROM knowledge_documents WHERE org_id = $1 AND namespace = $2", [
      orgId,
      namespace,
    ]);
    return result.rowCount ?? 0;
  }
}

function mapDocument(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id,
    orgId: row.org_id,
    namespace: row.namespace,
    ownerId: row.owner_id,
    title: row.title,
    slug: row.slug,
    category: row.category,
    visibility: row.visibility,
    status: row.status,
    verificationStatus: row.verification_status,
    version: row.version,
    summary: row.summary,
    sections: row.sections,
    contentMd: row.content_md,
    contentHash: row.content_hash,
    fingerprint: row.fingerprint,
    riskFlags: row.risk_flags,
    tags: row.tags,
    sourceClient: row.source_client,
    estimatedEffortTokens: row.estimated_effort_tokens,
    measuredEffortTokens: row.measured_effort_tokens,
    feedback: {
      helpful: row.helpful_count,
      outdated: row.outdated_count,
      incorrect: row.incorrect_count,
      irrelevant: row.irrelevant_count,
      retrievals: row.retrieval_count,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapDuplicate(row: DuplicateDbRow): DuplicateRow {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    namespace: row.namespace,
    visibility: row.visibility,
    ownerId: row.owner_id,
    updatedAt: row.updated_at,
    exact: row.exact === true,
    titleSimilarity: Number(row.title_similarity) || 0,
    problemSimilarity: Number(row.problem_similarity) || 0,
  };
}
