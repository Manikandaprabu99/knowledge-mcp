import { z } from "zod";
import { estimateTokens } from "../services/token-estimator.js";
import { formatSearchResults } from "./format.js";
import { categorySchema, namespaceSchema, runTool, tagsSchema, textResult, type ToolContext } from "./shared.js";

const DESCRIPTION =
  "Call this FIRST, before substantial research, debugging, analysis, or implementation, to reuse work that was already done. " +
  "Returns short ranked summaries (knowledge_id, version, score, confidence, verification status, match reasons) of documents you are authorized to read. " +
  "Check that a result really applies before reusing it; call get_knowledge only when a summary is not enough.";

export function registerSearchKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "search_knowledge",
    {
      title: "Search stored knowledge",
      description: DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(2)
          .max(2_000)
          .describe("The task, error message, or question you are about to work on."),
        namespace: namespaceSchema.optional().describe("Only this project/workspace namespace. Omit to search all you can access."),
        category: categorySchema.optional().describe("Only this category, e.g. troubleshooting, how-to, decision."),
        tags: tagsSchema.optional().describe("Only documents with at least one of these tags; more matches rank higher."),
        limit: z.coerce.number().int().min(1).max(50).optional().describe("Maximum results (server default 5)."),
        min_score: z.coerce.number().min(0).max(1).optional().describe("Minimum score 0..1 (server default 0.15)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "search_knowledge", async (identity) => {
        const response = await ctx.services.search.search(identity, {
          query: args.query,
          namespace: args.namespace,
          category: args.category,
          tags: args.tags,
          limit: args.limit,
          minScore: args.min_score,
        });
        const seen = ctx.session.seenSummaries;
        const alreadyShown = new Set(response.items.filter((item) => seen.has(item.id, item.contentHash)).map((item) => item.id));
        for (const item of response.items) seen.mark(item.id, item.contentHash);
        const text = formatSearchResults(response, alreadyShown);
        ctx.services.metrics.increment(identity.orgId, "estimated_tokens_returned", estimateTokens(text));
        return textResult(text);
      }),
  );
}
