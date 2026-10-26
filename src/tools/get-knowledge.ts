import { z } from "zod";
import { estimateTokens } from "../services/token-estimator.js";
import { SECTION_KEYS } from "../types/domain.js";
import { formatDocumentView } from "./format.js";
import { knowledgeIdSchema, runTool, textResult, versionSchema, type ToolContext } from "./shared.js";

export function registerGetKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "get_knowledge",
    {
      title: "Get a knowledge document",
      description:
        "Retrieve a knowledge document you are authorized to read, as Markdown with metadata, version and verification status. " +
        "Use only when a search summary is not enough; request specific sections to keep context small.",
      inputSchema: {
        knowledge_id: knowledgeIdSchema,
        sections: z
          .array(z.enum(SECTION_KEYS))
          .min(1)
          .max(SECTION_KEYS.length)
          .optional()
          .describe('Return only these sections, e.g. ["solution","implementation"].'),
        version: versionSchema.optional().describe("A historical version number instead of the latest."),
        if_none_match: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[0-9a-f]{8,64}$/)
          .optional()
          .describe("content_hash you already have; returns 'not modified' without content if unchanged."),
        max_chars: z.coerce.number().int().min(500).max(200_000).optional().describe("Truncate the returned Markdown."),
        force: z.boolean().optional().describe("Return the content even if it was already returned in this session."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "get_knowledge", async (identity) => {
        const view = await ctx.services.storage.get(identity, args.knowledge_id, { version: args.version });
        const id = view.document.id;
        if (args.if_none_match && view.contentHash.startsWith(args.if_none_match)) {
          return textResult(`Not modified: ${id} v${view.version} still has content_hash ${view.contentHash.slice(0, 16)}. Reuse the copy you have.`);
        }
        const fullDocument = args.sections === undefined;
        if (fullDocument && !args.force && ctx.session.seenDocuments.has(id, view.contentHash)) {
          return textResult(
            `Already returned in this session: ${id} v${view.version} (content_hash ${view.contentHash.slice(0, 16)}) is unchanged. ` +
              "Call again with force=true if it is no longer in your context.",
          );
        }
        const text = formatDocumentView(view, { sections: args.sections, maxChars: args.max_chars });
        if (fullDocument && !args.max_chars) ctx.session.seenDocuments.mark(id, view.contentHash);
        ctx.services.metrics.increment(identity.orgId, "estimated_tokens_returned", estimateTokens(text));
        return textResult(text);
      }),
  );
}
