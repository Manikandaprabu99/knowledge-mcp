import { describe, expect, it } from "vitest";
import { loadConfig, type RuntimeMode } from "../../src/config/env.js";
import { ConfigError } from "../../src/utils/errors.js";

const base = { DATABASE_URL: "postgres://ukm:secret@localhost:5432/knowledge", MCP_AUTH_TOKEN: "a".repeat(40) };

function problemsOf(env: Record<string, string>, mode: RuntimeMode = "http"): string {
  try {
    loadConfig(env, mode);
    return "";
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.join("\n");
    throw error;
  }
}

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig(base, "http");
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.namespace).toBe("default");
    expect(config.defaultVisibility).toBe("private");
    expect(config.search.defaultLimit).toBe(5);
    expect(config.redactEmails).toBe(true);
    expect(config.embeddings).toBeNull();
  });

  it("explains how to fix a missing or invalid DATABASE_URL", () => {
    expect(problemsOf({ MCP_AUTH_TOKEN: base.MCP_AUTH_TOKEN })).toMatch(/DATABASE_URL is required.*postgres:\/\/user:password@localhost/);
    expect(problemsOf({ ...base, DATABASE_URL: "mysql://root@localhost/db" })).toMatch(/must start with postgres:\/\//);
  });

  it("requires a strong token for the HTTP server and rejects the example placeholder", () => {
    expect(problemsOf({ DATABASE_URL: base.DATABASE_URL })).toMatch(/MCP_AUTH_TOKEN is required for the HTTP server/);
    expect(problemsOf({ ...base, MCP_AUTH_TOKEN: "s3cr3t-too-short" })).toMatch(/at least 32 characters/);
    expect(problemsOf({ ...base, MCP_AUTH_TOKEN: "replace-with-a-long-random-token" })).toMatch(/placeholder/);
  });

  it("never echoes secret values in error messages", () => {
    const problems = problemsOf({ DATABASE_URL: "postgres://user:hunter2@", MCP_AUTH_TOKEN: "s3cr3t-too-short" });
    expect(problems).not.toContain("s3cr3t-too-short");
    expect(problems).not.toContain("hunter2");
  });

  it("applies mode-specific token rules", () => {
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL }, "cli").authToken).toBeUndefined();
    expect(problemsOf({ DATABASE_URL: base.DATABASE_URL }, "stdio")).toMatch(/MCP_USER_TOKEN/);
    expect(problemsOf({ ...base, MCP_USER_TOKEN: "not-a-ukm-token" }, "stdio")).toMatch(/starts with ukm_/);
  });

  it("validates enums, numbers and booleans with the variable name", () => {
    expect(problemsOf({ ...base, DEFAULT_VISIBILITY: "public" })).toMatch(/DEFAULT_VISIBILITY/);
    expect(problemsOf({ ...base, DB_POOL_MAX: "0" })).toMatch(/DB_POOL_MAX/);
    expect(problemsOf({ ...base, TRUST_PROXY: "maybe" })).toMatch(/TRUST_PROXY/);
    expect(problemsOf({ ...base, SEARCH_DEFAULT_LIMIT: "30", SEARCH_MAX_LIMIT: "10" })).toMatch(/SEARCH_DEFAULT_LIMIT/);
  });

  it("prefers MCP_SERVER_PORT over the platform PORT and ignores empty values", () => {
    expect(loadConfig({ ...base, PORT: "8080" }, "http").port).toBe(8080);
    expect(loadConfig({ ...base, PORT: "8080", MCP_SERVER_PORT: "9000" }, "http").port).toBe(9000);
    expect(loadConfig({ ...base, KNOWLEDGE_NAMESPACE: "" }, "http").namespace).toBe("default");
  });

  it("parses origins and optional embeddings settings", () => {
    const config = loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com" }, "http");
    expect(config.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(problemsOf({ ...base, ALLOWED_ORIGINS: "https://a.example.com/path" })).toMatch(/ALLOWED_ORIGINS/);
    expect(problemsOf({ ...base, EMBEDDINGS_URL: "http://localhost:11434/v1" })).toMatch(/EMBEDDINGS_MODEL is required/);
    const withEmbeddings = loadConfig({ ...base, EMBEDDINGS_URL: "http://localhost:11434/v1/", EMBEDDINGS_MODEL: "nomic-embed-text" }, "http");
    expect(withEmbeddings.embeddings?.url).toBe("http://localhost:11434/v1");
  });
});
