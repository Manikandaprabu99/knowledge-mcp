import { describe, expect, it } from "vitest";
import type { DocumentCounts, UsageIncrement } from "../../src/database/repositories/usage-repository.js";
import { RateLimiter } from "../../src/security/rate-limiter.js";
import { estimateEffortTokens, estimateNetSavings, estimateTokens } from "../../src/services/token-estimator.js";
import { UsageMetrics, type UsageStore } from "../../src/services/usage-metrics.js";
import { generateKnowledgeId, KNOWLEDGE_ID_PATTERN } from "../../src/utils/ids.js";
import { createLogger } from "../../src/utils/logger.js";
import { LruCache } from "../../src/utils/lru-cache.js";
import { plainExcerpt, titleKey, truncate } from "../../src/utils/text.js";

class FakeUsageStore implements UsageStore {
  batches: UsageIncrement[][] = [];
  fail = false;

  async addDaily(increments: readonly UsageIncrement[]): Promise<void> {
    if (this.fail) throw new Error("database down");
    this.batches.push([...increments]);
  }

  async summarize(): Promise<Record<string, number>> {
    return {
      search_requests: 10,
      search_hits: 7,
      search_cache_hits: 2,
      search_latency_ms_total: 150,
      estimated_tokens_avoided: 5_000,
      estimated_tokens_returned: 800,
      feedback_reuse: 3,
    };
  }

  async documentCounts(): Promise<DocumentCounts> {
    return { active: 5, archived: 1, verified: 2, privateCount: 1, sharedCount: 4, publicCount: 0 };
  }
}

describe("utilities", () => {
  it("rate limiter refills over time and can be disabled", () => {
    let time = 0;
    const limiter = new RateLimiter(2, () => time);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const denied = limiter.consume("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(30);
    time += 30_000;
    expect(limiter.consume("k").allowed).toBe(true);
    expect(new RateLimiter(0).consume("x").allowed).toBe(true);
  });

  it("LRU cache evicts least recently used entries and expires by TTL", () => {
    let time = 0;
    const cache = new LruCache<number>(2, 1_000, () => time);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    time = 2_000;
    expect(cache.get("a")).toBeUndefined();
  });

  it("generates unique, time-sortable knowledge ids", () => {
    const first = generateKnowledgeId(1_700_000_000_000);
    const second = generateKnowledgeId(1_700_000_000_001);
    expect(first).toMatch(KNOWLEDGE_ID_PATTERN);
    expect(first.slice(0, 13) < second.slice(0, 13)).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => generateKnowledgeId())).size).toBe(200);
  });

  it("normalizes titles in any script and truncates on word boundaries", () => {
    expect(titleKey("PostgreSQL: JSONB / GIN!")).toBe("postgresql-jsonb-gin");
    expect(titleKey("தமிழ் தலைப்பு")).toBe("தமிழ்-தலைப்பு");
    expect(truncate("one two three four", 10)).toBe("one two…");
  });

  it("keeps technical characters in plain-text excerpts while dropping Markdown markup", () => {
    expect(plainExcerpt("payload @> '{}' with jsonb_path_ops; see ~/.pgpass, a -> b, *really* _now_ ~~old~~ | grep", 200)).toBe(
      "payload @> '{}' with jsonb_path_ops; see ~/.pgpass, a -> b, really now old | grep",
    );
    expect(plainExcerpt("> quoted **bold** line\n- item with [a link](https://example.com)", 200)).toBe("quoted bold line item with a link");
  });

  it("estimates tokens and labels nothing as measured", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateEffortTokens("a".repeat(400))).toBe(400);
    expect(estimateNetSavings(100, 150)).toBe(0);
  });

  it("buffers usage metrics, retries failed flushes and derives rates", async () => {
    const store = new FakeUsageStore();
    const metrics = new UsageMetrics(store, createLogger("silent"));
    metrics.increment("acme", "search_requests");
    metrics.increment("acme", "search_requests", 2);
    metrics.increment("other", "search_requests");
    store.fail = true;
    await metrics.flush();
    expect(store.batches).toHaveLength(0);
    store.fail = false;
    await metrics.flush();
    expect(store.batches[0]).toEqual([
      { orgId: "acme", metric: "search_requests", value: 3 },
      { orgId: "other", metric: "search_requests", value: 1 },
    ]);
    expect(metrics.snapshot().search_requests).toBe(4);

    const report = await metrics.report("acme", 30);
    expect(report.derived.searchHitRate).toBe(0.7);
    expect(report.derived.cacheHitRate).toBe(0.2);
    expect(report.derived.averageSearchLatencyMs).toBe(15);
    expect(report.derived.estimatedNetTokensSaved).toBe(4_200);
    expect(report.totals.measured_tokens_saved).toBe(0);
  });
});
