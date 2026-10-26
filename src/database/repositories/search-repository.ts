import type { QueryResultRow } from "pg";
import { readablePredicate } from "../../services/access-control.js";
import type { Identity, VerificationStatus, Visibility } from "../../types/domain.js";
import { SqlParams } from "../../utils/sql.js";
import type { Queryable } from "../client.js";

/** Upper bounds per retrieval stage keep scoring cost predictable as the store grows. */
const EXACT_CANDIDATES = 5;
const FTS_CANDIDATES = 100;
const TRIGRAM_CANDIDATES = 30;
const TAG_CANDIDATES = 50;
const SEMANTIC_CANDIDATES = 30;

export interface CandidateQuery {
  query: string;
  /** OR-joined tsquery built from safe tokens, or null when the query has no searchable terms. */
  tsQuery: string | null;
  titleKey: string | null;
  wantedTags: string[];
  namespace?: string | undefined;
  category?: string | undefined;
  tagsAny: string[];
  embedding: { vector: string; model: string } | null;
}

export interface CandidateRow {
  id: string;
  title: string;
  namespace: string;
  category: string;
  visibility: Visibility;
  version: number;
  summary: string;
  contentHash: string;
  verificationStatus: VerificationStatus;
  riskFlags: string[];
  tags: string[];
  updatedAt: Date;
  estimatedEffortTokens: number;
  helpfulCount: number;
  outdatedCount: number;
  incorrectCount: number;
  irrelevantCount: number;
  exactTitle: boolean;
  termCoverage: number;
  titleCoverage: number;
  trigram: number;
  tagMatches: number;
  semantic: number | null;
}

interface CandidateDbRow extends QueryResultRow {
  id: string;
  title: string;
  namespace: string;
  category: string;
  visibility: Visibility;
  version: number;
  summary: string;
  content_hash: string;
  verification_status: VerificationStatus;
  risk_flags: string[];
  tags: string[];
  updated_at: Date;
  estimated_effort_tokens: number;
  helpful_count: number;
  outdated_count: number;
  incorrect_count: number;
  irrelevant_count: number;
  exact_title: boolean | null;
  term_coverage: number | null;
  title_coverage: number | null;
  trigram: number | null;
  tag_matches: number | null;
  semantic: number | null;
}

/**
 * Progressive retrieval in one round trip: exact title, full-text, trigram, tag and (optionally)
 * pgvector candidates are unioned, access-filtered inside each stage, then raw ranking signals are
 * computed only for the small candidate set. Final scoring happens in relevance-ranking.ts.
 */
export class SearchRepository {
  constructor(private readonly db: Queryable) {}

  async findCandidates(identity: Identity, input: CandidateQuery): Promise<CandidateRow[]> {
    const params = new SqlParams();
    const filters = [`d.status = 'active'`, readablePredicate("d", identity, params)];
    if (input.namespace) filters.push(`d.namespace = ${params.add(input.namespace)}::text`);
    if (input.category) filters.push(`d.category = ${params.add(input.category)}::text`);
    if (input.tagsAny.length > 0) {
      filters.push(
        `EXISTS (SELECT 1 FROM document_tags ft WHERE ft.document_id = d.id AND ft.tag = ANY(${params.add(input.tagsAny)}::text[]))`,
      );
    }
    const base = filters.join(" AND ");
    const rawQuery = params.add(input.query);
    const tsQuery = params.add(input.tsQuery);
    const titleKey = params.add(input.titleKey);
    const wanted = params.add(input.wantedTags);

    let semanticStage = "";
    let semanticScore = "NULL::float8";
    if (input.embedding) {
      const vector = params.add(input.embedding.vector);
      const model = params.add(input.embedding.model);
      semanticStage = `UNION
        (SELECT e.document_id AS id FROM knowledge_embeddings e JOIN knowledge_documents d ON d.id = e.document_id
          WHERE ${base} AND e.model = ${model}::text
          ORDER BY e.embedding <=> ${vector}::vector LIMIT ${SEMANTIC_CANDIDATES})`;
      semanticScore = `(SELECT (1 - (e.embedding <=> ${vector}::vector))::float8 FROM knowledge_embeddings e
                          WHERE e.document_id = d.id AND e.model = ${model}::text)`;
    }

    const sql = `
      WITH q AS (
        SELECT to_tsquery('english', ${tsQuery}::text) AS tsq,
               tsvector_to_array(to_tsvector('english', ${rawQuery}::text)) AS lexemes
      ),
      candidates AS (
        (SELECT d.id FROM knowledge_documents d WHERE ${base} AND d.slug = ${titleKey}::text LIMIT ${EXACT_CANDIDATES})
        UNION
        (SELECT d.id FROM knowledge_documents d CROSS JOIN q
          WHERE ${base} AND q.tsq IS NOT NULL AND d.search_vector @@ q.tsq
          ORDER BY ts_rank_cd(d.search_vector, q.tsq) DESC LIMIT ${FTS_CANDIDATES})
        UNION
        (SELECT d.id FROM knowledge_documents d
          WHERE ${base} AND (d.title % ${rawQuery}::text OR ${rawQuery}::text <% d.title)
          ORDER BY similarity(d.title, ${rawQuery}::text) DESC LIMIT ${TRIGRAM_CANDIDATES})
        UNION
        (SELECT t.document_id AS id FROM document_tags t JOIN knowledge_documents d ON d.id = t.document_id
          WHERE ${base} AND t.tag = ANY(${wanted}::text[])
          GROUP BY t.document_id ORDER BY count(*) DESC LIMIT ${TAG_CANDIDATES})
        ${semanticStage}
      )
      SELECT d.id, d.title, d.namespace, d.category, d.visibility, d.version, d.summary, d.content_hash,
             d.verification_status, d.risk_flags, d.updated_at, d.estimated_effort_tokens,
             ARRAY(SELECT t.tag FROM document_tags t WHERE t.document_id = d.id ORDER BY t.tag) AS tags,
             COALESCE(s.helpful_count, 0) AS helpful_count,
             COALESCE(s.outdated_count, 0) AS outdated_count,
             COALESCE(s.incorrect_count, 0) AS incorrect_count,
             COALESCE(s.irrelevant_count, 0) AS irrelevant_count,
             (d.slug = ${titleKey}::text) AS exact_title,
             COALESCE(cardinality(ARRAY(SELECT unnest(q.lexemes) INTERSECT SELECT unnest(tsvector_to_array(d.search_vector))))::float8
                      / NULLIF(cardinality(q.lexemes), 0), 0) AS term_coverage,
             COALESCE(cardinality(ARRAY(SELECT unnest(q.lexemes) INTERSECT SELECT unnest(tsvector_to_array(to_tsvector('english', d.title)))))::float8
                      / NULLIF(cardinality(q.lexemes), 0), 0) AS title_coverage,
             GREATEST(similarity(d.title, ${rawQuery}::text), word_similarity(d.title, ${rawQuery}::text))::float8 AS trigram,
             (SELECT count(*) FROM document_tags t WHERE t.document_id = d.id AND t.tag = ANY(${wanted}::text[]))::int AS tag_matches,
             ${semanticScore} AS semantic
      FROM candidates c
      JOIN knowledge_documents d ON d.id = c.id
      LEFT JOIN document_stats s ON s.document_id = d.id
      CROSS JOIN q`;

    const result = await this.db.query<CandidateDbRow>(sql, params.values);
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      namespace: row.namespace,
      category: row.category,
      visibility: row.visibility,
      version: row.version,
      summary: row.summary,
      contentHash: row.content_hash,
      verificationStatus: row.verification_status,
      riskFlags: row.risk_flags,
      tags: row.tags,
      updatedAt: row.updated_at,
      estimatedEffortTokens: row.estimated_effort_tokens,
      helpfulCount: row.helpful_count,
      outdatedCount: row.outdated_count,
      incorrectCount: row.incorrect_count,
      irrelevantCount: row.irrelevant_count,
      exactTitle: row.exact_title === true,
      termCoverage: Number(row.term_coverage) || 0,
      titleCoverage: Number(row.title_coverage) || 0,
      trigram: Number(row.trigram) || 0,
      tagMatches: Number(row.tag_matches) || 0,
      semantic: row.semantic === null ? null : Number(row.semantic),
    }));
  }
}
