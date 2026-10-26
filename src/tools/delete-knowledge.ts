import { z } from "zod";
import { knowledgeIdSchema, runTool, textResult, type ToolContext } from "./shared.js";

export function registerDeleteKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "delete_knowledge",
    {
      title: "Archive or delete a knowledge document",
      description:
        "Archive (default: hidden from search, purged after the retention period) or permanently delete a document. " +
        "Allowed for the owner, or an org admin for shared/public documents. Ask the user before deleting.",
      inputSchema: {
        knowledge_id: knowledgeIdSchema,
        mode: z.enum(["archive", "delete"]).optional().describe("archive (default) or delete (permanent, removes history)."),
        reason: z.string().max(300).optional().describe("Short reason recorded in the audit log."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "delete_knowledge", async (identity) => {
        const mode = args.mode ?? "archive";
        const result = await ctx.services.storage.remove(identity, args.knowledge_id, mode, args.reason);
        const messages = {
          archived: `Archived ${args.knowledge_id}. It no longer appears in search and will be purged after the retention period.`,
          already_archived: `${args.knowledge_id} was already archived.`,
          deleted: `Permanently deleted ${args.knowledge_id} and its version history.`,
        } as const;
        return textResult(messages[result.status]);
      }),
  );
}
