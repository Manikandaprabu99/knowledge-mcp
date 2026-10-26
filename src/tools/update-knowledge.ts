import { z } from "zod";
import { formatWriteNotes } from "./format.js";
import {
  categorySchema,
  connectedClientName,
  knowledgeIdSchema,
  runTool,
  tagsSchema,
  textResult,
  validationSchema,
  versionSchema,
  visibilitySchema,
  type ToolContext,
} from "./shared.js";

export function registerUpdateKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "update_knowledge",
    {
      title: "Update a knowledge document",
      description:
        "Correct or extend an existing document. Requires expected_version (from search or get) so newer edits are never overwritten; " +
        "every update creates a new version and keeps history. mode=merge (default) appends to sections, mode=replace overwrites the sections you send.",
      inputSchema: {
        knowledge_id: knowledgeIdSchema,
        expected_version: versionSchema.describe("The version your change is based on."),
        change_summary: z.string().trim().min(3).max(500).describe("What changed and why."),
        mode: z.enum(["merge", "replace"]).optional(),
        title: z.string().trim().min(5).max(200).optional(),
        problem: z.string().max(20_000).optional(),
        context: z.string().max(20_000).optional(),
        solution: z.string().max(50_000).optional(),
        implementation: z.string().max(80_000).optional(),
        reasoning_summary: z.string().max(10_000).optional(),
        validation: validationSchema.optional(),
        follow_up: z.string().max(10_000).optional(),
        summary: z.string().max(400).optional(),
        tags: tagsSchema.optional(),
        category: categorySchema.optional(),
        visibility: visibilitySchema.optional().describe("Only the owner (or an org admin) can change visibility."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "update_knowledge", async (identity) => {
        const result = await ctx.services.storage.update(identity, {
          knowledgeId: args.knowledge_id,
          expectedVersion: args.expected_version,
          changeSummary: args.change_summary,
          mode: args.mode ?? "merge",
          title: args.title,
          problem: args.problem,
          context: args.context,
          solution: args.solution,
          implementation: args.implementation,
          reasoningSummary: args.reasoning_summary,
          validation: args.validation,
          followUp: args.follow_up,
          summary: args.summary,
          tags: args.tags,
          category: args.category,
          visibility: args.visibility,
          sourceClient: connectedClientName(ctx),
        });
        const doc = result.document;
        return textResult(
          [
            `Updated ${doc.id} from v${result.previousVersion} to v${doc.version} (changed: ${result.changed.join(", ")}; ${doc.verificationStatus}). History is preserved.`,
            ...formatWriteNotes(result),
          ].join("\n"),
        );
      }),
  );
}
