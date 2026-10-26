import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_INSTRUCTIONS } from "../../src/server/instructions.js";
import { APP_VERSION } from "../../src/version.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("repository consistency", () => {
  it("APP_VERSION matches package.json", () => {
    expect(APP_VERSION).toBe((JSON.parse(read("package.json")) as { version: string }).version);
  });

  it("docs/AGENT_INSTRUCTIONS.md contains the prompt the server serves", () => {
    expect(read("docs/AGENT_INSTRUCTIONS.md")).toContain(AGENT_INSTRUCTIONS);
  });

  it(".env.example documents every required variable", () => {
    const example = read(".env.example");
    for (const key of ["DATABASE_URL", "MCP_SERVER_PORT", "MCP_AUTH_TOKEN", "KNOWLEDGE_NAMESPACE", "DEFAULT_VISIBILITY", "LOG_LEVEL"]) {
      expect(example).toContain(`${key}=`);
    }
  });

  it("every package bin has a TypeScript entry point with a shebang", () => {
    const pkg = JSON.parse(read("package.json")) as { bin: Record<string, string> };
    expect(Object.keys(pkg.bin)).toContain("universal-knowledge-mcp");
    for (const target of Object.values(pkg.bin)) {
      const source = target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      expect(read(source).startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });
});
