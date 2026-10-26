import { estimateTokens } from "../services/token-estimator.js";
import { knowledgeIdSchema, runTool, UNTRUSTED_NOTICE, versionSchema, type ToolContext } from "./shared.js";

export function registerExportKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "export_knowledge",
    {
      title: "Export a knowledge document as Markdown",
      description:
        "Return the complete .md file (YAML front matter + sections) of a document you can read, as an embedded text/markdown resource. " +
        "On HTTP deployments the same file is downloadable at GET /export/<knowledge_id>.md with your bearer token.",
      inputSchema: {
        knowledge_id: knowledgeIdSchema,
        version: versionSchema.optional().describe("Export a historical version."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "export_knowledge", async (identity) => {
        const exported = await ctx.services.storage.export(identity, args.knowledge_id, args.version);
        ctx.services.metrics.increment(identity.orgId, "estimated_tokens_returned", estimateTokens(exported.markdown));
        return {
          content: [
            {
              type: "text",
              text: `${UNTRUSTED_NOTICE}\nExport of ${args.knowledge_id} v${exported.version} as ${exported.fileName} (${Buffer.byteLength(exported.markdown, "utf8")} bytes).`,
            },
            {
              type: "resource",
              resource: {
                uri: `knowledge://documents/${args.knowledge_id}/versions/${exported.version}`,
                mimeType: "text/markdown",
                text: exported.markdown,
              },
            },
          ],
        };
      }),
  );
}
