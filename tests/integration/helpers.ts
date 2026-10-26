import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "../../src/config/env.js";
import { runMigrations } from "../../src/database/migrator.js";
import { createAppServices, initializeDatabase, shutdownServices, type AppServices } from "../../src/server/bootstrap.js";
import { callToolText, connectInMemoryClient } from "../../src/server/in-memory.js";
import type { Identity, Role } from "../../src/types/domain.js";
import { createLogger } from "../../src/utils/logger.js";

/** Integration tests run only when TEST_DATABASE_URL points at a disposable PostgreSQL database. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdefghijklmnop";
const ID_PATTERN = /kn_[0-9a-hjkmnp-tv-z]{26}/;

type UserKey = "alice" | "bob" | "carol" | "rita" | "ada";

export interface TestEnv {
  services: AppServices;
  identities: Record<UserKey, Identity>;
  connect(identity: Identity, clientName?: string): Promise<Client>;
  close(): Promise<void>;
}

const USERS: ReadonlyArray<readonly [UserKey, string, Role, boolean]> = [
  ["alice", "acme", "member", false],
  ["bob", "acme", "member", false],
  ["carol", "globex", "member", false],
  ["rita", "acme", "reader", false],
  ["ada", "acme", "admin", true],
];

export async function setupTestEnvironment(overrides: Record<string, string> = {}): Promise<TestEnv> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set.");
  const config = loadConfig(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      MCP_AUTH_TOKEN: ADMIN_TOKEN,
      LOG_LEVEL: "silent",
      SEARCH_CACHE_TTL_SECONDS: "0",
      RATE_LIMIT_PER_MINUTE: "0",
      ...overrides,
    },
    "http",
  );
  const logger = createLogger("silent");
  const services = createAppServices(config, logger);
  await runMigrations(services.db, logger);
  await services.db.query("TRUNCATE knowledge_documents, api_tokens, users, audit_log, usage_daily RESTART IDENTITY CASCADE");
  await initializeDatabase(services);

  const identities = {} as Record<UserKey, Identity>;
  for (const [id, orgId, role, canReadPublic] of USERS) {
    await services.users.createUser({ id, displayName: id, orgId, role, canReadPublic });
    identities[id] = { userId: id, orgId, role, canReadPublic, authMethod: "api_token" };
  }

  const closers: Array<() => Promise<void>> = [];
  return {
    services,
    identities,
    connect: async (identity, clientName = "test-client") => {
      const connection = await connectInMemoryClient(services, identity, clientName);
      closers.push(connection.close);
      return connection.client;
    },
    close: async () => {
      for (const close of closers) await close().catch(() => undefined);
      await shutdownServices(services);
    },
  };
}

export const call = callToolText;

export function extractId(text: string): string {
  const id = ID_PATTERN.exec(text)?.[0];
  if (!id) throw new Error(`No knowledge id found in: ${text}`);
  return id;
}
