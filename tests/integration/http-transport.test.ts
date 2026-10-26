import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp, type HttpApp } from "../../src/server/http-app.js";
import { callToolText } from "../../src/server/in-memory.js";
import { extractId, setupTestEnvironment, TEST_DATABASE_URL, type TestEnv } from "./helpers.js";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw-http-test", version: "1.0.0" } },
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe.skipIf(!TEST_DATABASE_URL)("Streamable HTTP transport", () => {
  let env: TestEnv;
  let app: HttpApp;
  let baseUrl = "";
  let aliceToken = "";
  let bobToken = "";

  beforeAll(async () => {
    env = await setupTestEnvironment({ ALLOWED_ORIGINS: "https://allowed.example.com" });
    aliceToken = (await env.services.users.createToken("alice", { label: "test" })).token;
    bobToken = (await env.services.users.createToken("bob", { label: "test" })).token;
    app = createHttpApp(env.services);
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  it("serves health and readiness probes", async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
  });

  it("rejects missing or unknown bearer tokens", async () => {
    const anonymous = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(INITIALIZE) });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/Bearer/);
    const unknown = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ukm_${"x".repeat(43)}` },
      body: JSON.stringify(INITIALIZE),
    });
    expect(unknown.status).toBe(401);
  });

  it("rejects browser origins that are not allow-listed", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${aliceToken}`, origin: "https://evil.example.com" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(response.status).toBe(403);
  });

  it("works end to end with an MCP client over HTTP, including the Markdown download", async () => {
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${aliceToken}` } } }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("search_knowledge");
    expect(client.getInstructions()).toMatch(/search_knowledge/);
    const saved = await callToolText(client, "save_knowledge", {
      title: "Configuring Streamable HTTP for a remote MCP server",
      problem: "Remote MCP clients need a single endpoint that supports POST, GET and DELETE.",
      solution: "Expose /mcp with the Streamable HTTP transport and authenticate every request with a bearer token.",
      visibility: "shared",
    });
    const id = extractId(saved.text);
    expect((await callToolText(client, "search_knowledge", { query: "remote MCP Streamable HTTP endpoint" })).text).toContain(id);

    const download = await fetch(`${baseUrl}/export/${id}.md`, { headers: { authorization: `Bearer ${aliceToken}` } });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await download.text()).toContain(`knowledge_id: "${id}"`);
    expect((await fetch(`${baseUrl}/export/${id}.md`)).status).toBe(401);
    await client.close();
  });

  it("binds each session to one identity", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify(INITIALIZE),
    });
    const sessionId = init.headers.get("mcp-session-id");
    await init.body?.cancel();
    expect(sessionId).toBeTruthy();
    const hijack = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${bobToken}`, "mcp-session-id": sessionId ?? "" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(hijack.status).toBe(403);
  });
});
