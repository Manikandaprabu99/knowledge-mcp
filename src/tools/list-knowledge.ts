import { z } from "zod";
import { AppError } from "../utils/errors.js";
import { formatDate, singleLine, truncate } from "../utils/text.js";
import { normalizeCategory, normalizeTags } from "../services/knowledge-content.js";
import { categorySchema, identifierSchema, namespaceSchema, runTool, tagsSchema, textResult, visibilitySchema, type ToolContext } from "./shared.js";

const isoDate = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected an ISO-8601 date or timestamp");

export function registerListKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "list_knowledge",
    {
      title: "List knowledge documents",
      description: "List documents you can access (newest first), filtered by namespace, category, tags (all must match), creator, visibility, or date.",
      inputSchema: {
        namespace: namespaceSchema.optional(),
        category: categorySchema.optional(),
        tags: tagsSchema.optional(),
        created_by: identifierSchema.optional().describe("User id of the document owner."),
        visibility: visibilitySchema.optional(),
        updated_after: isoDate.optional(),
        updated_before: isoDate.optional(),
        include_archived: z.boolean().optional().describe("Include archived documents you are allowed to manage."),
        limit: z.coerce.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
        cursor: z.string().max(500).optional().describe("next_cursor from a previous call."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "list_knowledge", async (identity) => {
        if (args.updated_after && args.updated_before && Date.parse(args.updated_after) >= Date.parse(args.updated_before)) {
          throw new AppError("VALIDATION_ERROR", "updated_after must be earlier than updated_before.");
        }
        const page = await ctx.services.storage.list(
          identity,
          {
            namespace: args.namespace,
            category: args.category === undefined ? undefined : normalizeCategory(args.category),
            tags: args.tags ? normalizeTags(args.tags) : undefined,
            ownerId: args.created_by,
            visibility: args.visibility,
            updatedAfter: args.updated_after ? new Date(args.updated_after) : undefined,
            updatedBefore: args.updated_before ? new Date(args.updated_before) : undefined,
            includeArchived: args.include_archived ?? false,
          },
          args.limit ?? 20,
          args.cursor,
        );
        if (page.items.length === 0) return textResult("No accessible knowledge documents match these filters.");
        const lines = page.items.map(
          (item) =>
            `- ${item.id} v${item.version} · ${truncate(singleLine(item.title), 100)} · ${item.category} · ${item.visibility} · ` +
            `${item.verificationStatus.replace("_", " ")} · ns:${item.namespace} · by ${item.ownerId} · ${formatDate(item.updatedAt)}` +
            (item.status === "archived" ? " · ARCHIVED" : "") +
            (item.tags.length > 0 ? ` · tags: ${item.tags.join(", ")}` : ""),
        );
        if (page.nextCursor) lines.push(`next_cursor: ${page.nextCursor}`);
        return textResult(lines.join("\n"));
      }),
  );
}
