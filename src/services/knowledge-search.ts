import type { SearchConfig } from "../config/env.js";
import { pgErrorCode } from "../database/client.js";
import type { CandidateQuery, CandidateRow, SearchRepository } from "../database/repositories/search-repository.js";
import { sanitizeText } from "../security/sanitize.js";
import type { Identity, KnowledgeDocument, VerificationStatus, Visibility } from "../types/domain.js";
import { AppError } from "../utils/errors.js";
import { KNOWLEDGE_ID_PATTERN } from "../utils/ids.js";
import type { Logger } from "../utils/logger.js";
import type { LruCache } from "../utils/lru-cache.js";
import { singleLine, titleKey } from "../utils/text.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { normalizeCategory, normalizeTags } from "./knowledge-content.js";
import type { KnowledgeStorageService } from "./knowledge-storage.js";
import { rankCandidates, type Ranking, type RankingSignals } from "./relevance-ranking.js";
import { buildOrTsQuery, extractSearchTokens } from "./search-query.js";
import type { UsageMetrics } from "./usage-metrics.js";

export interface SearchInput {
  query: string;
  namespace?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  limit?: number | undefined;
  minScore?: number | undefined;
}

export interface SearchResultItem {
  id: string;
  title: string;
  namespace: string;
  category: string;
  visibility: Visibility;
  version: number;
  contentHash: string;
  summary: string;
  tags: string[];
  verificationStatus: VerificationStatus;
  updatedAt: Date;
  riskFlags: string[];
  feedback: { helpful: number; outdated: number; incorrect: number };
  ranking: Ranking;
}

export interface SearchResponse {
  query: string;
  items: SearchResultItem[];
  candidates: number;
  latencyMs: number;
  cacheHit: boolean;
  semantic: boolean;
}

export interface SearchDeps {
  repository: SearchRepository;
  storage: KnowledgeStorageService;
  metrics: UsageMetrics;
  logger: Logger;
  config: SearchConfig;
  embeddings: EmbeddingIndex | null;
  cache: LruCache<SearchResponse>;
}

/** Search orchestration: normalization, caching, candidate retrieval and ranking. No LLM calls. */
export class KnowledgeSearchService {
  constructor(private readonly deps: SearchDeps) {}

  async search(identity: Identity, input: SearchInput): Promise<SearchResponse> {
    const started = performance.now();
    const query = singleLine(sanitizeText(input.query)).slice(0, 2_000);
    if (query.length < 2) throw new AppError("VALIDATION_ERROR", "query must contain at least 2 characters.");
    if (KNOWLEDGE_ID_PATTERN.test(query)) return this.lookupById(identity, query, started);

    const limit = Math.min(Math.max(1, input.limit ?? this.deps.config.defaultLimit), this.deps.config.maxLimit);
    const minScore = input.minScore ?? this.deps.config.minScore;
    const tags = normalizeTags(input.tags ?? []);
    const category = input.category === undefined ? undefined : normalizeCategory(input.category);

    // Cache keys include the full access scope, so cached results never cross identities.
    const cacheKey = JSON.stringify([
      identity.userId,
      identity.orgId,
      identity.role,
      identity.canReadPublic,
      query.toLowerCase(),
      input.namespace ?? null,
      category ?? null,
      tags,
      limit,
      minScore,
    ]);
    const cached = this.deps.cache.get(cacheKey);
    if (cached) {
      const response = { ...cached, cacheHit: true, latencyMs: elapsed(started) };
      this.recordMetrics(identity, response);
      return response;
    }

    const tokens = extractSearchTokens(query);
    const embedding = this.deps.embeddings ? await this.deps.embeddings.queryVector(query) : null;
    const rows = await this.findCandidates(identity, {
      query,
      tsQuery: buildOrTsQuery(tokens),
      titleKey: titleKey(query) || null,
      wantedTags: [...new Set([...tags, ...normalizeTags(tokens)])],
      namespace: input.namespace,
      category,
      tagsAny: tags,
      embedding,
    });
    const ranked = rankCandidates(rows, toSignals, {
      now: new Date(),
      staleAfterDays: this.deps.config.staleAfterDays,
      minScore,
    }).slice(0, limit);

    const response: SearchResponse = {
      query,
      items: ranked.map(({ item, ranking }) => toItem(item, ranking)),
      candidates: rows.length,
      latencyMs: elapsed(started),
      cacheHit: false,
      semantic: embedding !== null,
    };
    this.deps.cache.set(cacheKey, response);
    this.recordMetrics(identity, response);
    return response;
  }

  invalidate(): void {
    this.deps.cache.clear();
  }

  private async findCandidates(identity: Identity, query: CandidateQuery): Promise<CandidateRow[]> {
    try {
      return await this.deps.repository.findCandidates(identity, query);
    } catch (error) {
      // Defensive: if PostgreSQL ever rejects the generated tsquery, fall back to trigram/tag retrieval.
      if (pgErrorCode(error) === "42601" && query.tsQuery !== null) {
        this.deps.logger.warn("Full-text query rejected; retrying without it");
        return this.deps.repository.findCandidates(identity, { ...query, tsQuery: null });
      }
      throw error;
    }
  }

  private async lookupById(identity: Identity, knowledgeId: string, started: number): Promise<SearchResponse> {
    const view = await this.deps.storage.get(identity, knowledgeId, { recordRetrieval: false });
    const doc = view.document;
    const ranking: Ranking = { score: 1, relevance: 1, confidence: "high", stale: false, reasons: ["exact knowledge_id"] };
    const response: SearchResponse = {
      query: knowledgeId,
      items: doc.status === "active" ? [documentToItem(doc, ranking)] : [],
      candidates: 1,
      latencyMs: elapsed(started),
      cacheHit: false,
      semantic: false,
    };
    this.recordMetrics(identity, response);
    return response;
  }

  private recordMetrics(identity: Identity, response: SearchResponse): void {
    const { metrics } = this.deps;
    metrics.increment(identity.orgId, "search_requests");
    metrics.increment(identity.orgId, "search_latency_ms_total", Math.round(response.latencyMs));
    if (response.items.length > 0) metrics.increment(identity.orgId, "search_hits");
    if (response.cacheHit) metrics.increment(identity.orgId, "search_cache_hits");
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

function toSignals(row: CandidateRow): RankingSignals {
  return {
    exactTitle: row.exactTitle,
    termCoverage: row.termCoverage,
    titleCoverage: row.titleCoverage,
    trigram: row.trigram,
    tagMatches: row.tagMatches,
    docTagCount: row.tags.length,
    semantic: row.semantic,
    verificationStatus: row.verificationStatus,
    helpfulCount: row.helpfulCount,
    outdatedCount: row.outdatedCount,
    incorrectCount: row.incorrectCount,
    irrelevantCount: row.irrelevantCount,
    updatedAt: row.updatedAt,
  };
}

function toItem(row: CandidateRow, ranking: Ranking): SearchResultItem {
  return {
    id: row.id,
    title: row.title,
    namespace: row.namespace,
    category: row.category,
    visibility: row.visibility,
    version: row.version,
    contentHash: row.contentHash,
    summary: row.summary,
    tags: row.tags,
    verificationStatus: row.verificationStatus,
    updatedAt: row.updatedAt,
    riskFlags: row.riskFlags,
    feedback: { helpful: row.helpfulCount, outdated: row.outdatedCount, incorrect: row.incorrectCount },
    ranking,
  };
}

function documentToItem(doc: KnowledgeDocument, ranking: Ranking): SearchResultItem {
  return {
    id: doc.id,
    title: doc.title,
    namespace: doc.namespace,
    category: doc.category,
    visibility: doc.visibility,
    version: doc.version,
    contentHash: doc.contentHash,
    summary: doc.summary,
    tags: doc.tags,
    verificationStatus: doc.verificationStatus,
    updatedAt: doc.updatedAt,
    riskFlags: doc.riskFlags,
    feedback: { helpful: doc.feedback.helpful, outdated: doc.feedback.outdated, incorrect: doc.feedback.incorrect },
    ranking,
  };
}
