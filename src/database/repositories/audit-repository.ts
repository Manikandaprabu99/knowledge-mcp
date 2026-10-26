import type { Queryable } from "../client.js";

export interface AuditEntry {
  actorId: string | null;
  action: string;
  documentId?: string | null;
  /** Metadata only (ids, versions, counts). Never document content or secrets. */
  details?: Record<string, unknown>;
}

export class AuditRepository {
  constructor(private readonly db: Queryable) {}

  async record(entry: AuditEntry, q: Queryable = this.db): Promise<void> {
    await q.query(
      "INSERT INTO audit_log (actor_id, action, document_id, details) VALUES ($1, $2, $3, $4::jsonb)",
      [entry.actorId, entry.action, entry.documentId ?? null, JSON.stringify(entry.details ?? {})],
    );
  }

  async purgeOlderThan(days: number): Promise<number> {
    const result = await this.db.query(
      "DELETE FROM audit_log WHERE occurred_at < now() - make_interval(days => $1::int)",
      [days],
    );
    return result.rowCount ?? 0;
  }
}
