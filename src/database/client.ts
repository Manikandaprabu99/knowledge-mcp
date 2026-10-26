import pg from "pg";
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";
import type { DatabaseSslMode } from "../config/env.js";
import { AppError, errorMessage } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";

/** Anything that can run a parameterized query: the pool or a transaction client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface DatabaseOptions {
  url: string;
  ssl: DatabaseSslMode;
  poolMax: number;
  queryTimeoutMs: number;
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
]);

const CONNECTION_ERROR_MESSAGE =
  /connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED|server closed the connection|Connection ended unexpectedly|query read timeout/i;

/** Thin wrapper over a pg pool: error classification, transactions, health checks, shutdown. */
export class Database implements Queryable {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions, logger: Logger) {
    const config: PoolConfig = {
      connectionString: options.url,
      max: options.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      query_timeout: options.queryTimeoutMs,
      application_name: "universal-knowledge-mcp",
    };
    const ssl = resolveSsl(options.ssl);
    if (ssl !== undefined) config.ssl = ssl;
    this.pool = new pg.Pool(config);
    // Without this handler an idle-client error (e.g. the server restarted) would crash the process.
    this.pool.on("error", (error: Error) => logger.warn("Idle PostgreSQL client error", { error }));
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    try {
      return await this.pool.query<R>(text, [...values]);
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }

  async withClient<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      return await work(wrapClient(client));
    } catch (error) {
      broken = isConnectionError(error);
      throw classifyDatabaseError(error);
    } finally {
      client.release(broken);
    }
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(wrapClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      broken = isConnectionError(error);
      if (!broken) await client.query("ROLLBACK").catch(() => undefined);
      throw classifyDatabaseError(error);
    } finally {
      client.release(broken);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async connect(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
  }
}

function wrapClient(client: PoolClient): Queryable {
  return {
    query: <R extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []) =>
      client.query<R>(text, [...values]),
  };
}

function resolveSsl(mode: DatabaseSslMode): PoolConfig["ssl"] | undefined {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: true };
    case "no-verify":
      return { rejectUnauthorized: false };
    case "auto":
      return undefined; // honor sslmode=... in DATABASE_URL
  }
}

export function isConnectionError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === "DATABASE_UNAVAILABLE";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  if (error instanceof AggregateError) return error.errors.some((inner) => isConnectionError(inner));
  return error instanceof Error && CONNECTION_ERROR_MESSAGE.test(error.message);
}

/** Maps driver errors to actionable AppErrors; other errors pass through unchanged (keeping their SQLSTATE). */
export function classifyDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (isConnectionError(error)) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "The knowledge database is not reachable right now. Check DATABASE_URL, network access, and whether the database is paused or sleeping.",
      undefined,
      { cause: error },
    );
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "42P01" || code === "42883") {
    return new AppError(
      "SCHEMA_NOT_READY",
      "The database schema is missing or outdated. Run `npm run migrate` (or set AUTO_MIGRATE=true) and retry.",
      undefined,
      { cause: error },
    );
  }
  if (code === "57014") {
    return new AppError("TIMEOUT", "The database query took too long and was cancelled.", undefined, { cause: error });
  }
  if (error instanceof Error) return error;
  return new Error(errorMessage(error));
}

/** SQLSTATE of a PostgreSQL error, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  const cause = error instanceof AppError ? (error.cause as { code?: unknown } | undefined) : error;
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected the query to return a row.");
  return row;
}
