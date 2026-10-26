import type { VerificationStatus } from "../types/domain.js";

/** Raw signals computed in SQL for each candidate (see search-repository.ts). */
export interface RankingSignals {
  exactTitle: boolean;
  /** Share of query lexemes found anywhere in the document (0..1). */
  termCoverage: number;
  /** Share of query lexemes found in the title (0..1). */
  titleCoverage: number;
  /** Trigram similarity between title and query (0..1). */
  trigram: number;
  tagMatches: number;
  docTagCount: number;
  /** Cosine similarity when semantic search is enabled, otherwise null. */
  semantic: number | null;
  verificationStatus: VerificationStatus;
  helpfulCount: number;
  outdatedCount: number;
  incorrectCount: number;
  irrelevantCount: number;
  updatedAt: Date;
}

export type Confidence = "high" | "medium" | "low";

export interface Ranking {
  score: number;
  relevance: number;
  confidence: Confidence;
  stale: boolean;
  reasons: string[];
}

export interface RankingOptions {
  now: Date;
  staleAfterDays: number;
  minScore: number;
}

const LEXICAL_WEIGHTS = { termCoverage: 0.45, titleCoverage: 0.2, trigram: 0.2, tags: 0.15 } as const;
const SEMANTIC_MAX_BOOST = 0.35;
const VERIFICATION_FACTOR: Record<VerificationStatus, number> = {
  verified: 1,
  partially_verified: 0.6,
  unverified: 0.3,
  failed: 0,
};
const FRESHNESS_HALF_LIFE_DAYS = 180;
const STALE_PENALTY = 0.9;
const DAY_MS = 86_400_000;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** How well the document matches the query (0..1). Quality signals never make an irrelevant document relevant. */
export function computeRelevance(signals: RankingSignals): number {
  if (signals.exactTitle) return 1;
  const tagScore = signals.docTagCount > 0 ? clamp01(signals.tagMatches / Math.min(signals.docTagCount, 3)) : 0;
  const lexical =
    LEXICAL_WEIGHTS.termCoverage * clamp01(signals.termCoverage) +
    LEXICAL_WEIGHTS.titleCoverage * clamp01(signals.titleCoverage) +
    LEXICAL_WEIGHTS.trigram * clamp01(signals.trigram) +
    LEXICAL_WEIGHTS.tags * tagScore;
  if (signals.semantic === null) return clamp01(lexical);
  // Semantic similarity lifts paraphrases that share few words, without lowering lexical matches.
  const boost = SEMANTIC_MAX_BOOST * clamp01((signals.semantic - 0.5) / 0.5);
  return clamp01(lexical + boost * (1 - lexical));
}

/** Laplace-smoothed share of positive feedback; 0.5 when there is none. */
export function computeUsefulness(helpful: number, outdated: number, incorrect: number, irrelevant: number): number {
  const negative = outdated + 1.5 * incorrect + 0.25 * irrelevant;
  return (helpful + 1) / (helpful + negative + 2);
}

export function computeFreshness(updatedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
}

export function isStale(signals: Pick<RankingSignals, "updatedAt" | "outdatedCount" | "helpfulCount">, now: Date, staleAfterDays: number): boolean {
  const ageDays = (now.getTime() - signals.updatedAt.getTime()) / DAY_MS;
  return ageDays > staleAfterDays || (signals.outdatedCount >= 2 && signals.outdatedCount > signals.helpfulCount);
}

export function rankSignals(signals: RankingSignals, options: Omit<RankingOptions, "minScore">): Ranking {
  const relevance = computeRelevance(signals);
  const usefulness = computeUsefulness(
    signals.helpfulCount,
    signals.outdatedCount,
    signals.incorrectCount,
    signals.irrelevantCount,
  );
  const freshness = computeFreshness(signals.updatedAt, options.now);
  const stale = isStale(signals, options.now, options.staleAfterDays);
  // Quality multiplier in [0.70, 1.00]: verification, feedback and freshness re-order relevant results.
  const quality = 0.7 + 0.12 * VERIFICATION_FACTOR[signals.verificationStatus] + 0.12 * usefulness + 0.06 * freshness;
  const score = round3(relevance * quality * (stale ? STALE_PENALTY : 1));

  const reasons: string[] = [];
  if (signals.exactTitle) reasons.push("exact title match");
  if (signals.termCoverage > 0) reasons.push(`${Math.round(clamp01(signals.termCoverage) * 100)}% of query terms`);
  if (signals.trigram >= 0.4) reasons.push("similar title");
  if (signals.tagMatches > 0) reasons.push(`${signals.tagMatches} matching tag${signals.tagMatches === 1 ? "" : "s"}`);
  if (signals.semantic !== null && signals.semantic >= 0.75) reasons.push("semantically similar");

  const confidence: Confidence = score >= 0.6 ? "high" : score >= 0.35 ? "medium" : "low";
  return { score, relevance: round3(relevance), confidence, stale, reasons };
}

/** Scores, filters by minScore, and sorts candidates (best first, newest first on ties). */
export function rankCandidates<T>(
  items: readonly T[],
  signalsOf: (item: T) => RankingSignals,
  options: RankingOptions,
): Array<{ item: T; ranking: Ranking }> {
  return items
    .map((item) => ({ item, ranking: rankSignals(signalsOf(item), options) }))
    .filter((entry) => entry.ranking.score >= options.minScore)
    .sort(
      (a, b) =>
        b.ranking.score - a.ranking.score ||
        signalsOf(b.item).updatedAt.getTime() - signalsOf(a.item).updatedAt.getTime(),
    );
}
