import type { QueryResultRow } from "pg";
import type { Queryable } from "../client.js";

export interface UsageIncrement {
  orgId: string;
  metric: string;
  value: number;
}

export interface DocumentCounts {
  active: number;
  archived: number;
  verified: number;
  privateCount: number;
  sharedCount: number;
  publicCount: number;
}

interface MetricRow extends QueryResultRow {
  metric: string;
  total: number;
}

interface CountRow extends QueryResultRow {
  active: number;
  archived: number;
  verified: number;
  private_count: number;
  shared_count: number;
  public_count: number;
}

/** Daily per-organization counters, so usage statistics survive restarts. */
export class UsageRepository {
  constructor(private readonly db: Queryable) {}

  async addDaily(increments: readonly UsageIncrement[]): Promise<void> {
    if (increments.length === 0) return;
    await this.db.query(
      `INSERT INTO usage_daily (day, org_id, metric, value)
       SELECT CURRENT_DATE, x.org_id, x.metric, x.value
       FROM unnest($1::text[], $2::text[], $3::bigint[]) AS x(org_id, metric, value)
       ON CONFLICT (day, org_id, metric) DO UPDATE SET value = usage_daily.value + EXCLUDED.value`,
      [increments.map((i) => i.orgId), increments.map((i) => i.metric), increments.map((i) => Math.round(i.value))],
    );
  }

  async summarize(orgId: string, days: number): Promise<Record<string, number>> {
    const result = await this.db.query<MetricRow>(
      `SELECT metric, sum(value)::float8 AS total FROM usage_daily
       WHERE org_id = $1 AND day > CURRENT_DATE - $2::int
       GROUP BY metric`,
      [orgId, days],
    );
    return Object.fromEntries(result.rows.map((row) => [row.metric, row.total]));
  }

  async documentCounts(orgId: string): Promise<DocumentCounts> {
    const result = await this.db.query<CountRow>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'archived')::int AS archived,
              count(*) FILTER (WHERE status = 'active' AND verification_status = 'verified')::int AS verified,
              count(*) FILTER (WHERE status = 'active' AND visibility = 'private')::int AS private_count,
              count(*) FILTER (WHERE status = 'active' AND visibility = 'shared')::int AS shared_count,
              count(*) FILTER (WHERE status = 'active' AND visibility = 'public')::int AS public_count
       FROM knowledge_documents WHERE org_id = $1`,
      [orgId],
    );
    const row = result.rows[0];
    return {
      active: row?.active ?? 0,
      archived: row?.archived ?? 0,
      verified: row?.verified ?? 0,
      privateCount: row?.private_count ?? 0,
      sharedCount: row?.shared_count ?? 0,
      publicCount: row?.public_count ?? 0,
    };
  }
}
