import type { DocumentCounts, UsageIncrement } from "../database/repositories/usage-repository.js";
import type { Logger } from "../utils/logger.js";

export const METRICS = [
  "search_requests",
  "search_hits",
  "search_latency_ms_total",
  "search_cache_hits",
  "documents_saved",
  "documents_updated",
  "duplicates_avoided",
  "documents_retrieved",
  "feedback_reuse",
  "feedback_negative",
  "estimated_tokens_returned",
  "estimated_tokens_avoided",
  "measured_tokens_saved",
] as const;
export type MetricName = (typeof METRICS)[number];

export interface UsageStore {
  addDaily(increments: readonly UsageIncrement[]): Promise<void>;
  summarize(orgId: string, days: number): Promise<Record<string, number>>;
  documentCounts(orgId: string): Promise<DocumentCounts>;
}

export interface UsageReport {
  days: number;
  documents: DocumentCounts;
  totals: Record<MetricName, number>;
  derived: {
    searchHitRate: number | null;
    cacheHitRate: number | null;
    averageSearchLatencyMs: number | null;
    reuseConfirmations: number;
    /** Heuristic: estimated effort of reused documents minus estimated tokens returned by the server. */
    estimatedNetTokensSaved: number;
    /** Sum of values reported by clients that measured their own usage. */
    measuredTokensSaved: number;
  };
}

/** Buffers counters in memory and flushes them to PostgreSQL periodically (and on shutdown). */
export class UsageMetrics {
  private pending = new Map<string, UsageIncrement>();
  private readonly totals = new Map<MetricName, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: UsageStore,
    private readonly logger: Logger,
    private readonly maxPending = 5_000,
  ) {}

  increment(orgId: string, metric: MetricName, value = 1): void {
    if (!Number.isFinite(value) || value === 0) return;
    this.totals.set(metric, (this.totals.get(metric) ?? 0) + value);
    this.addPending({ orgId, metric, value });
  }

  /** Counters since process start. */
  snapshot(): Record<MetricName, number> {
    return Object.fromEntries(METRICS.map((metric) => [metric, this.totals.get(metric) ?? 0])) as Record<MetricName, number>;
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending = new Map();
    try {
      await this.store.addDaily(batch);
    } catch (error) {
      this.logger.warn("Could not persist usage metrics; they will be retried", { error, entries: batch.length });
      for (const entry of batch) this.addPending(entry);
    }
  }

  /** Organization-level statistics for the last `days` days (persisted counters, flushed first). */
  async report(orgId: string, days: number): Promise<UsageReport> {
    await this.flush();
    const [usage, documents] = await Promise.all([this.store.summarize(orgId, days), this.store.documentCounts(orgId)]);
    const totals = Object.fromEntries(METRICS.map((metric) => [metric, usage[metric] ?? 0])) as Record<MetricName, number>;
    const ratio = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
    return {
      days,
      documents,
      totals,
      derived: {
        searchHitRate: ratio(totals.search_hits, totals.search_requests),
        cacheHitRate: ratio(totals.search_cache_hits, totals.search_requests),
        averageSearchLatencyMs:
          totals.search_requests > 0 ? Math.round(totals.search_latency_ms_total / totals.search_requests) : null,
        reuseConfirmations: totals.feedback_reuse,
        estimatedNetTokensSaved: Math.max(0, totals.estimated_tokens_avoided - totals.estimated_tokens_returned),
        measuredTokensSaved: totals.measured_tokens_saved,
      },
    };
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private addPending(entry: UsageIncrement): void {
    const key = `${entry.orgId}\u0000${entry.metric}`;
    const existing = this.pending.get(key);
    if (existing) existing.value += entry.value;
    else if (this.pending.size < this.maxPending) this.pending.set(key, { ...entry });
  }
}
