import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { registerDeleteKnowledgeTool } from "../tools/delete-knowledge.js";
import { registerExportKnowledgeTool } from "../tools/export-knowledge.js";
import { registerGetKnowledgeTool } from "../tools/get-knowledge.js";
import { registerKnowledgeFeedbackTool } from "../tools/knowledge-feedback.js";
import { registerKnowledgeStatsTool } from "../tools/knowledge-stats.js";
import { registerListKnowledgeTool } from "../tools/list-knowledge.js";
import { registerSaveKnowledgeTool } from "../tools/save-knowledge.js";
import { registerSearchKnowledgeTool } from "../tools/search-knowledge.js";
import type { ToolContext, ToolRegistrar } from "../tools/shared.js";
import { registerUpdateKnowledgeTool } from "../tools/update-knowledge.js";
import { APP_NAME, APP_VERSION } from "../version.js";
import type { AppServices } from "./bootstrap.js";
import { AGENT_INSTRUCTIONS, SERVER_INSTRUCTIONS } from "./instructions.js";
import type { SessionContext } from "./session.js";

const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerSearchKnowledgeTool,
  registerGetKnowledgeTool,
  registerSaveKnowledgeTool,
  registerUpdateKnowledgeTool,
  registerListKnowledgeTool,
  registerExportKnowledgeTool,
  registerDeleteKnowledgeTool,
  registerKnowledgeFeedbackTool,
  registerKnowledgeStatsTool,
];

/** Builds one MCP server instance for one session (stdio process, HTTP session, or in-memory test client). */
export function createKnowledgeServer(services: AppServices, session: SessionContext): McpServer {
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx: ToolContext = { services, session, server };
  for (const register of TOOL_REGISTRARS) register(ctx);

  server.registerPrompt(
    "knowledge_workflow",
    {
      title: "Knowledge-first workflow",
      description: "Instructions for searching stored knowledge before work and saving reusable results afterwards.",
    },
    (): GetPromptResult => ({ messages: [{ role: "user", content: { type: "text", text: AGENT_INSTRUCTIONS } }] }),
  );
  return server;
}
