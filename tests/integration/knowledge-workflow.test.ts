import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, extractId, setupTestEnvironment, TEST_DATABASE_URL, type TestEnv } from "./helpers.js";

const JSONB_DOC = {
  title: "PostgreSQL JSONB containment query is slow without a GIN index",
  problem: "Queries using payload @> '{\"type\":\"order\"}' took 4 seconds on a 2M-row events table.",
  context: "PostgreSQL 16, table events(payload jsonb), no index on payload.",
  solution: "Create a GIN index with jsonb_path_ops and run ANALYZE so @> queries use a bitmap index scan.",
  implementation: "```sql\nCREATE INDEX CONCURRENTLY events_payload_path_ops ON events USING GIN (payload jsonb_path_ops);\n```",
  validation: { status: "verified", evidence: "EXPLAIN ANALYZE showed a Bitmap Index Scan; latency fell from 4.1 s to 12 ms." },
  tags: ["postgresql", "jsonb", "performance"],
  visibility: "shared",
};

describe.skipIf(!TEST_DATABASE_URL)("knowledge workflow on PostgreSQL (acceptance criteria)", () => {
  let env: TestEnv;
  let jsonbId = "";

  beforeAll(async () => {
    env = await setupTestEnvironment();
  });
  afterAll(async () => {
    await env?.close();
  });

  it("exposes tools, the workflow prompt and server instructions", async () => {
    const client = await env.connect(env.identities.alice);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "search_knowledge",
      "get_knowledge",
      "save_knowledge",
      "update_knowledge",
      "list_knowledge",
      "export_knowledge",
      "delete_knowledge",
      "knowledge_feedback",
      "knowledge_stats",
    ]) {
      expect(names).toContain(name);
    }
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("knowledge_workflow");
    expect(client.getInstructions()).toMatch(/search_knowledge/);
  });

  it("1-5 & 7: saves Markdown to PostgreSQL and reuses it from a new session and another client", async () => {
    const claude = await env.connect(env.identities.alice, "claude-code");
    const saved = await call(claude, "save_knowledge", JSONB_DOC);
    expect(saved.isError).toBe(false);
    expect(saved.text).toMatch(/^Saved kn_/);
    jsonbId = extractId(saved.text);

    const stored = await env.services.db.query<{ content_md: string; version: number; owner_id: string; source_client: string }>(
      "SELECT content_md, version, owner_id, source_client FROM knowledge_documents WHERE id = $1",
      [jsonbId],
    );
    const row = stored.rows[0];
    expect(row?.version).toBe(1);
    expect(row?.owner_id).toBe("alice");
    expect(row?.source_client).toBe("claude-code");
    expect(row?.content_md).toContain(`knowledge_id: "${jsonbId}"`);
    expect(row?.content_md).toContain("## Solution");
    expect(row?.content_md).toContain('verification_status: "verified"');

    const newSession = await env.connect(env.identities.alice, "claude-code");
    const found = await call(newSession, "search_knowledge", { query: "slow jsonb containment query in postgres" });
    expect(found.text).toContain(jsonbId);
    expect(found.text).toContain("UNTRUSTED REFERENCE MATERIAL");
    expect((await call(newSession, "get_knowledge", { knowledge_id: jsonbId })).text).toContain("jsonb_path_ops");
    expect((await call(newSession, "get_knowledge", { knowledge_id: jsonbId })).text).toMatch(/Already returned in this session/);

    const cursor = await env.connect(env.identities.bob, "cursor");
    expect((await call(cursor, "search_knowledge", { query: "jsonb GIN index", tags: ["postgresql"] })).text).toContain(jsonbId);
  });

  it("6 & 12: shares knowledge inside the organization without exposing private documents", async () => {
    const alice = await env.connect(env.identities.alice);
    const privateSave = await call(alice, "save_knowledge", {
      title: "Alice private deployment notes for staging",
      problem: "Staging deploys need a manual cache flush after migrations.",
      solution: "Run the cache flush job after migrations finish on staging.",
      tags: ["deployment"],
      visibility: "private",
    });
    const privateId = extractId(privateSave.text);

    const bob = await env.connect(env.identities.bob);
    expect((await call(bob, "search_knowledge", { query: "staging deploy cache flush migrations" })).text).not.toContain(privateId);
    const get = await call(bob, "get_knowledge", { knowledge_id: privateId });
    expect(get.isError).toBe(true);
    expect(get.text).toMatch(/No accessible knowledge document/);
    expect(
      (await call(bob, "update_knowledge", { knowledge_id: privateId, expected_version: 1, change_summary: "try", solution: "hijack" })).isError,
    ).toBe(true);
    expect((await call(bob, "delete_knowledge", { knowledge_id: privateId })).isError).toBe(true);
    expect((await call(bob, "list_knowledge", {})).text).not.toContain(privateId);

    const carol = await env.connect(env.identities.carol);
    expect((await call(carol, "search_knowledge", { query: "jsonb containment GIN index" })).text).toMatch(/No stored knowledge matched/);
    expect((await call(carol, "get_knowledge", { knowledge_id: jsonbId })).isError).toBe(true);
  });

  it("12: enforces roles for saving and publishing", async () => {
    const rita = await env.connect(env.identities.rita);
    const denied = await call(rita, "save_knowledge", {
      title: "Reader attempt to save knowledge",
      problem: "Readers should not be able to save.",
      solution: "The server rejects the request.",
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/read-only/);

    const alice = await env.connect(env.identities.alice);
    expect(
      (
        await call(alice, "save_knowledge", {
          title: "Member attempt to publish publicly",
          problem: "Members should not publish public knowledge.",
          solution: "Only admins can choose public visibility.",
          visibility: "public",
        })
      ).isError,
    ).toBe(true);

    const ada = await env.connect(env.identities.ada);
    const published = await call(ada, "save_knowledge", {
      title: "Public guide: rotating API tokens safely",
      problem: "Teams need a safe process to rotate API tokens.",
      solution: "Issue a new token, deploy it, verify traffic, then revoke the old token.",
      visibility: "public",
    });
    expect(published.isError).toBe(false);
    const carol = await env.connect(env.identities.carol);
    expect((await call(carol, "get_knowledge", { knowledge_id: extractId(published.text) })).isError).toBe(true);
  });

  it("8: detects exact and near duplicates", async () => {
    const bob = await env.connect(env.identities.bob);
    expect((await call(bob, "save_knowledge", JSONB_DOC)).text).toMatch(/identical knowledge already exists/);
    const rephrased = { ...JSONB_DOC, solution: "Add a GIN index (jsonb_path_ops) on payload and ANALYZE the table; containment queries then use it." };
    expect((await call(bob, "save_knowledge", rephrased)).text).toMatch(/similar knowledge already exists/);
    expect((await call(bob, "save_knowledge", { ...rephrased, on_duplicate: "create_new" })).text).toMatch(/^Saved kn_/);
    const count = await env.services.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM knowledge_documents WHERE title = $1",
      [JSONB_DOC.title],
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it("9: updates preserve history, reset unsupported verification and reject stale versions", async () => {
    const alice = await env.connect(env.identities.alice);
    const created = await call(alice, "save_knowledge", {
      title: "Fixing ECONNREFUSED when Node.js connects to PostgreSQL in Docker",
      problem: "A Node.js app in Docker Compose gets ECONNREFUSED 127.0.0.1:5432.",
      solution: "Use the compose service name (db) as the host instead of localhost.",
      validation: { status: "verified", evidence: "Container logs show a successful connection after the change." },
      tags: ["docker", "postgresql"],
      visibility: "shared",
    });
    const id = extractId(created.text);
    const updated = await call(alice, "update_knowledge", {
      knowledge_id: id,
      expected_version: 1,
      change_summary: "Add healthcheck advice",
      solution: "Also add depends_on with condition: service_healthy.",
    });
    expect(updated.text).toMatch(/from v1 to v2/);
    expect(updated.text).toMatch(/reset to unverified/);

    const conflict = await call(alice, "update_knowledge", { knowledge_id: id, expected_version: 1, change_summary: "Stale edit", follow_up: "x" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toMatch(/Version conflict.*expected_version=2/s);

    const v1 = await call(alice, "get_knowledge", { knowledge_id: id, version: 1 });
    expect(v1.text).toContain('version="1"');
    expect(v1.text).not.toContain("depends_on");
    expect((await call(alice, "get_knowledge", { knowledge_id: id, sections: ["solution"] })).text).toContain("depends_on");
    const versions = await env.services.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM knowledge_versions WHERE document_id = $1",
      [id],
    );
    expect(versions.rows[0]?.count).toBe(2);

    const bob = await env.connect(env.identities.bob);
    expect(
      (
        await call(bob, "update_knowledge", {
          knowledge_id: id,
          expected_version: 2,
          change_summary: "Add Windows note",
          follow_up: "On Docker Desktop for Windows, host.docker.internal reaches the host.",
        })
      ).isError,
    ).toBe(false);
    expect(
      (await call(bob, "update_knowledge", { knowledge_id: id, expected_version: 3, change_summary: "Hide it", visibility: "private" })).isError,
    ).toBe(true);
  });

  it("redacts secrets before anything is persisted", async () => {
    const alice = await env.connect(env.identities.alice);
    const saved = await call(alice, "save_knowledge", {
      title: "Rotating a leaked GitHub token in CI",
      problem: `A CI log leaked the token ghp_${"A".repeat(36)} for the deploy bot.`,
      solution: "Revoke the token, issue a new one, and store it only as an encrypted CI secret.",
    });
    expect(saved.text).toMatch(/Redacted before saving: 1 api key/);
    const row = await env.services.db.query<{ content_md: string }>("SELECT content_md FROM knowledge_documents WHERE id = $1", [
      extractId(saved.text),
    ]);
    expect(row.rows[0]?.content_md).not.toContain("ghp_AAAA");
  });

  it("records feedback, statistics, export and archive", async () => {
    const bob = await env.connect(env.identities.bob);
    const feedback = await call(bob, "knowledge_feedback", { knowledge_id: jsonbId, outcome: "solved" });
    expect(feedback.text).toMatch(/Feedback recorded/);
    expect(feedback.text).toMatch(/heuristic estimate/);
    expect((await call(bob, "knowledge_stats", { days: 1 })).text).toMatch(/1 confirmed reuses/);

    const alice = await env.connect(env.identities.alice);
    const exported = await call(alice, "export_knowledge", { knowledge_id: jsonbId });
    expect(exported.text).toContain(`knowledge_id: "${jsonbId}"`);
    expect((await call(alice, "delete_knowledge", { knowledge_id: jsonbId })).text).toMatch(/Archived/);
    expect((await call(bob, "search_knowledge", { query: "jsonb containment GIN index" })).text).not.toContain(jsonbId);
  });

  it("13: works without any LLM or embedding service", () => {
    expect(env.services.config.embeddings).toBeNull();
    expect(env.services.embeddings).toBeNull();
  });
});
