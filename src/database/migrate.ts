#!/usr/bin/env node
import { loadConfig, loadDotEnvFile } from "../config/env.js";
import { ConfigError, errorMessage } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import { Database } from "./client.js";
import { runMigrations } from "./migrator.js";
import { UserRepository } from "./repositories/user-repository.js";

/** CLI: apply pending migrations and make sure the bootstrap admin user exists. */
async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig(process.env, "cli");
  const logger = createLogger(config.logLevel === "silent" ? "info" : config.logLevel, { component: "migrate" });
  const db = new Database(
    { url: config.databaseUrl, ssl: config.databaseSsl, poolMax: 2, queryTimeoutMs: 120_000 },
    logger,
  );
  try {
    const applied = await runMigrations(db, logger);
    await new UserRepository(db).ensureUser({
      id: config.authUserId,
      displayName: config.authUserId,
      orgId: config.authOrgId,
      role: "admin",
      canReadPublic: true,
    });
    logger.info(applied.length > 0 ? "Migrations complete" : "Database schema already up to date", { applied });
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : `Migration failed: ${errorMessage(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
