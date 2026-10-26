import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createAppServices, shutdownServices } from "../../src/server/bootstrap.js";
import { callToolText, connectInMemoryClient } from "../../src/server/in-memory.js";
import { createLogger } from "../../src/utils/logger.js";

/** Runs without PostgreSQL: nothing listens on port 1, so every query fails with ECONNREFUSED. */
describe("when PostgreSQL is unreachable", () => {
  it("returns actionable tool errors instead of crashing the process", async () => {
    const config = loadConfig(
      {
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        MCP_AUTH_TOKEN: "test-admin-token-0123456789abcdefghijklmnop",
        LOG_LEVEL: "silent",
        DB_QUERY_TIMEOUT_MS: "2000",
      },
      "http",
    );
    const services = createAppServices(config, createLogger("silent"));
    const connection = await connectInMemoryClient(services, services.auth.bootstrapIdentity(), "offline-test");
    try {
      const result = await callToolText(connection.client, "search_knowledge", { query: "anything at all" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/Knowledge store unavailable/);
      expect(result.text).toMatch(/Continue the task normally/);
      expect(await services.db.ping()).toBe(false);
    } finally {
      await connection.close();
      await shutdownServices(services);
    }
  });
});
