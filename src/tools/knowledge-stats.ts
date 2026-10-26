import { z } from "zod";
import { runTool, textResult, type ToolContext } from "./shared.js";

export function registerKnowledgeStatsTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "knowledge_stats",
    {
      title: "Knowledge usage statistics",
      description:
        "Organization-level usage statistics: searches, hit and cache rates, latency, saves, duplicates avoided, reuse, and token savings (estimated vs. client-measured).",
      inputSchema: {
        days: z.coerce.number().int().min(1).max(365).optional().describe("Look-back window in days (default 30)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "knowledge_stats", async (identity) => {
        const days = args.days ?? 30;
        const report = await ctx.services.metrics.report(identity.orgId, days);
        const { totals, derived, documents } = report;
        const percent = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
        return textResult(
          [
            `Knowledge stats for organization "${identity.orgId}", last ${days} days:`,
            `- Documents: ${documents.active} active (${documents.verified} verified; ${documents.privateCount} private, ${documents.sharedCount} shared, ${documents.publicCount} public), ${documents.archived} archived`,
            `- Searches: ${totals.search_requests} (hit rate ${percent(derived.searchHitRate)}, cache hit rate ${percent(derived.cacheHitRate)}, avg latency ${derived.averageSearchLatencyMs ?? "n/a"} ms)`,
            `- Saved: ${totals.documents_saved} new, ${totals.documents_updated} updates, ${totals.duplicates_avoided} duplicates avoided`,
            `- Reuse: ${totals.documents_retrieved} full retrievals, ${derived.reuseConfirmations} confirmed reuses, ${totals.feedback_negative} negative reports`,
            `- Tokens: ~${derived.estimatedNetTokensSaved} estimated net tokens saved (heuristic: reused effort minus tokens returned); ${derived.measuredTokensSaved} measured tokens saved reported by clients`,
          ].join("\n"),
        );
      }),
  );
}
