import { describe, expect, it } from "vitest";
import { computeRelevance, rankCandidates, rankSignals, type RankingSignals } from "../../src/services/relevance-ranking.js";

const now = new Date("2026-10-01T00:00:00Z");
const options = { now, staleAfterDays: 365 };
const signals = (overrides: Partial<RankingSignals> = {}): RankingSignals => ({
  exactTitle: false,
  termCoverage: 0,
  titleCoverage: 0,
  trigram: 0,
  tagMatches: 0,
  docTagCount: 0,
  semantic: null,
  verificationStatus: "unverified",
  helpfulCount: 0,
  outdatedCount: 0,
  incorrectCount: 0,
  irrelevantCount: 0,
  updatedAt: now,
  ...overrides,
});

describe("relevance ranking", () => {
  it("treats an exact title match as fully relevant", () => {
    const ranking = rankSignals(signals({ exactTitle: true, verificationStatus: "verified" }), options);
    expect(ranking.relevance).toBe(1);
    expect(ranking.confidence).toBe("high");
    expect(ranking.reasons).toContain("exact title match");
  });

  it("ranks verified, helpful documents above equally relevant unverified ones", () => {
    const base = { termCoverage: 0.8, titleCoverage: 0.5, trigram: 0.5 };
    const verified = rankSignals(signals({ ...base, verificationStatus: "verified", helpfulCount: 3 }), options).score;
    expect(verified).toBeGreaterThan(rankSignals(signals(base), options).score);
  });

  it("never lets quality signals make an irrelevant document relevant", () => {
    expect(rankSignals(signals({ verificationStatus: "verified", helpfulCount: 50 }), options).score).toBe(0);
  });

  it("penalizes outdated feedback and marks old documents stale", () => {
    const fresh = rankSignals(signals({ termCoverage: 1 }), options);
    const outdated = rankSignals(signals({ termCoverage: 1, outdatedCount: 3 }), options);
    expect(outdated.stale).toBe(true);
    expect(outdated.score).toBeLessThan(fresh.score);
    expect(rankSignals(signals({ termCoverage: 1, updatedAt: new Date("2024-01-01T00:00:00Z") }), options).stale).toBe(true);
  });

  it("filters by minimum score and sorts best first", () => {
    const items = [
      { id: "weak", s: signals({ termCoverage: 0.2 }) },
      { id: "strong", s: signals({ termCoverage: 0.9, titleCoverage: 0.8, trigram: 0.7 }) },
      { id: "none", s: signals() },
    ];
    const ranked = rankCandidates(items, (item) => item.s, { ...options, minScore: 0.05 });
    expect(ranked.map((entry) => entry.item.id)).toEqual(["strong", "weak"]);
  });

  it("lets semantic similarity lift paraphrases without lowering lexical matches", () => {
    const lexical = computeRelevance(signals({ termCoverage: 0.5 }));
    expect(computeRelevance(signals({ termCoverage: 0.5, semantic: 0.9 }))).toBeGreaterThan(lexical);
    expect(computeRelevance(signals({ termCoverage: 0.5, semantic: 0.1 }))).toBe(lexical);
    expect(computeRelevance(signals({ semantic: 0.95 }))).toBeGreaterThan(0.2);
  });
});
