#!/usr/bin/env node
import { loadConfig, loadDotEnvFile } from "../config/env.js";
import { runMigrations } from "../database/migrator.js";
import { createAppServices, initializeDatabase, shutdownServices } from "../server/bootstrap.js";
import { callToolText, connectInMemoryClient } from "../server/in-memory.js";
import type { Identity } from "../types/domain.js";
import { errorMessage } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import { truncate } from "../utils/text.js";

/**
 * End-to-end demonstration against a real PostgreSQL database (DATABASE_URL), using real MCP clients
 * over in-memory transports. Data lives in the "demo" namespace of the "demo-org" organization and is reset each run.
 */
const ORG = "demo-org";
const NAMESPACE = "demo";

const identity = (userId: string, orgId = ORG): Identity => ({
  userId,
  orgId,
  role: "member",
  canReadPublic: false,
  authMethod: "api_token",
});

async function main(): Promise<void> {
  loadDotEnvFile();
  const config = loadConfig({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn", SEARCH_CACHE_TTL_SECONDS: "0" }, "cli");
  const logger = createLogger(config.logLevel);
  const services = createAppServices(config, logger);
  const step = (title: string, text: string): void => {
    process.stdout.write(`\n=== ${title} ===\n${truncate(text, 900)}\n`);
  };

  try {
    await runMigrations(services.db, logger);
    await initializeDatabase(services);
    for (const id of ["demo-alice", "demo-bob"]) {
      await services.users.ensureUser({ id, displayName: id, orgId: ORG, role: "member", canReadPublic: false });
    }
    await services.users.ensureUser({ id: "demo-carol", displayName: "demo-carol", orgId: "other-org", role: "member", canReadPublic: false });
    await services.documents.deleteNamespace(ORG, NAMESPACE);

    const alice = await connectInMemoryClient(services, identity("demo-alice"), "claude-code");
    const query = { query: "postgres jsonb @> containment query slow", namespace: NAMESPACE };
    step("1. Alice searches before working (nothing stored yet)", (await callToolText(alice.client, "search_knowledge", query)).text);

    const saved = await callToolText(alice.client, "save_knowledge", {
      title: "PostgreSQL JSONB containment query is slow without a GIN index",
      problem: "SELECT ... WHERE payload @> '{\"type\":\"order\"}' took about 4 seconds on a 2M-row events table.",
      context: "PostgreSQL 16; table events(id bigint, payload jsonb); no index on payload.",
      solution: "Create a GIN index using jsonb_path_ops, then ANALYZE the table. @> queries switch to a bitmap index scan.",
      implementation: "```sql\nCREATE INDEX CONCURRENTLY events_payload_path_ops ON events USING GIN (payload jsonb_path_ops);\nANALYZE events;\n```",
      validation: { status: "verified", evidence: "EXPLAIN ANALYZE shows Bitmap Index Scan; latency dropped from 4.1 s to 12 ms." },
      tags: ["postgresql", "jsonb", "performance", "index"],
      category: "troubleshooting",
      namespace: NAMESPACE,
      visibility: "shared",
    });
    step("2. Alice saves the verified fix as shared knowledge", saved.text);
    const knowledgeId = /kn_[0-9a-hjkmnp-tv-z]{26}/.exec(saved.text)?.[0];
    if (!knowledgeId) throw new Error("The demo could not save its document; see the output above.");

    step(
      "3. Alice saves a private note (only she can see it)",
      (
        await callToolText(alice.client, "save_knowledge", {
          title: "Personal psql shortcuts for the events table",
          problem: "I keep retyping the same psql commands when debugging JSONB queries.",
          solution: "Use \\x auto and \\timing on, and keep EXPLAIN (ANALYZE, BUFFERS) handy for @> queries.",
          tags: ["postgresql", "psql"],
          namespace: NAMESPACE,
          visibility: "private",
        })
      ).text,
    );
    await alice.close();

    const aliceAgain = await connectInMemoryClient(services, identity("demo-alice"), "claude-code");
    step("4. New Alice session: the same question now finds the stored fix", (await callToolText(aliceAgain.client, "search_knowledge", query)).text);

    const bob = await connectInMemoryClient(services, identity("demo-bob"), "cursor");
    step(
      "5. Bob, from a different MCP client, finds the shared fix but not Alice's private note",
      (await callToolText(bob.client, "search_knowledge", { query: "jsonb psql postgresql", namespace: NAMESPACE })).text,
    );
    step(
      "6. Bob retrieves only the sections he needs",
      (await callToolText(bob.client, "get_knowledge", { knowledge_id: knowledgeId, sections: ["solution", "implementation"] })).text,
    );

    step(
      "7. Alice tries to save the same solution again: duplicate detected",
      (
        await callToolText(aliceAgain.client, "save_knowledge", {
          title: "PostgreSQL JSONB containment query is slow without a GIN index",
          problem: "SELECT ... WHERE payload @> '{\"type\":\"order\"}' took about 4 seconds on a 2M-row events table.",
          solution: "Create a GIN index using jsonb_path_ops, then ANALYZE the table. @> queries switch to a bitmap index scan.",
          namespace: NAMESPACE,
          visibility: "shared",
        })
      ).text,
    );
    step(
      "8. Alice improves the document; history is kept",
      (
        await callToolText(aliceAgain.client, "update_knowledge", {
          knowledge_id: knowledgeId,
          expected_version: 1,
          change_summary: "Add note about key-existence operators",
          follow_up: "jsonb_path_ops does not support ? / ?| / ?& key-existence operators; use the default jsonb_ops class for those.",
        })
      ).text,
    );
    step(
      "9. Bob reports that the document solved his task",
      (await callToolText(bob.client, "knowledge_feedback", { knowledge_id: knowledgeId, outcome: "solved" })).text,
    );

    const carol = await connectInMemoryClient(services, identity("demo-carol", "other-org"), "other-client");
    step("10. Carol from another organization cannot read it", (await callToolText(carol.client, "get_knowledge", { knowledge_id: knowledgeId })).text);
    step("11. Usage statistics", (await callToolText(bob.client, "knowledge_stats", { days: 1 })).text);

    await Promise.all([aliceAgain.close(), bob.close(), carol.close()]);
    process.stdout.write("\nDemo complete.\n");
  } finally {
    await shutdownServices(services);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Demo failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
