import { z } from "zod";
import { FEEDBACK_OUTCOMES } from "../types/domain.js";
import { knowledgeIdSchema, runTool, textResult, versionSchema, type ToolContext } from "./shared.js";

export function registerKnowledgeFeedbackTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "knowledge_feedback",
    {
      title: "Report whether knowledge helped",
      description:
        "After using a retrieved document, report whether it solved the task, was outdated, incorrect, or irrelevant. Feedback improves ranking for everyone.",
      inputSchema: {
        knowledge_id: knowledgeIdSchema,
        outcome: z.enum(FEEDBACK_OUTCOMES),
        version: versionSchema.optional().describe("Version you used (defaults to the latest)."),
        comment: z.string().max(1_000).optional().describe("Short, non-sensitive note, e.g. what was outdated."),
        measured_tokens_saved: z.coerce
          .number()
          .int()
          .min(0)
          .max(100_000_000)
          .optional()
          .describe("Only if your client measured actual token usage savings."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "knowledge_feedback", async (identity) => {
        const result = await ctx.services.storage.feedback(identity, {
          knowledgeId: args.knowledge_id,
          version: args.version,
          outcome: args.outcome,
          comment: args.comment,
          measuredTokensSaved: args.measured_tokens_saved,
        });
        const estimate =
          result.estimatedTokensAvoided > 0
            ? ` Estimated tokens avoided: ~${result.estimatedTokensAvoided} (heuristic estimate, not a measurement).`
            : "";
        return textResult(
          `Feedback ${result.recorded === "new" ? "recorded" : "updated"} for ${args.knowledge_id} v${result.version}: ${args.outcome}.${estimate}`,
        );
      }),
  );
}
