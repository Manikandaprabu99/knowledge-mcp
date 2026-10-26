import { AppError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import type { Database } from "./client.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

/** Arbitrary constant for pg_advisory_xact_lock so concurrent instances never migrate at the same time. */
const MIGRATION_LOCK_KEY = 4_412_771_903;

/**
 * Applies pending migrations, each in its own transaction guarded by a transaction-scoped
 * advisory lock (safe behind PgBouncer-style transaction poolers).
 */
export async function runMigrations(
  db: Database,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY,
         description TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  });

  const applied: string[] = [];
  for (const migration of migrations) {
    const ran = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const existing = await tx.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
      if (existing.rowCount && existing.rowCount > 0) return false;
      await migration.up(tx);
      await tx.query("INSERT INTO schema_migrations (id, description) VALUES ($1, $2)", [
        migration.id,
        migration.description,
      ]);
      return true;
    });
    if (ran) {
      applied.push(migration.id);
      logger.info("Applied migration", { migration: migration.id });
    }
  }
  return applied;
}

export async function pendingMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  const table = await db.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (!table.rows[0]?.present) return migrations.map((migration) => migration.id);
  const result = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  const done = new Set(result.rows.map((row) => row.id));
  return migrations.filter((migration) => !done.has(migration.id)).map((migration) => migration.id);
}

export async function assertSchemaReady(db: Database): Promise<void> {
  const pending = await pendingMigrations(db);
  if (pending.length > 0) {
    throw new AppError(
      "SCHEMA_NOT_READY",
      `The database has ${pending.length} pending migration(s) (${pending.join(", ")}). Run \`npm run migrate\` or set AUTO_MIGRATE=true.`,
    );
  }
}
