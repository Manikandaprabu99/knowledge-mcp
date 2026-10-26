import { z } from "zod";
import type { SaveResult } from "../services/knowledge-storage.js";
import { ON_DUPLICATE_ACTIONS } from "../types/domain.js";
import { singleLine } from "../utils/text.js";
import { formatWriteNotes } from "./format.js";
import {
  categorySchema,
  connectedClientName,
  namespaceSchema,
  runTool,
  tagsSchema,
  textResult,
  validationSchema,
  visibilitySchema,
  type ToolContext,
} from "./shared.js";

export function registerSaveKnowledgeTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    "save_knowledge",
    {
      title: "Save reusable knowledge",
      description:
        "Save a completed task's reusable knowledge (fix, procedure, decision, verified answer) as a structured Markdown document. " +
        "Write a concise, de-identified summary: never include secrets, credentials, personal data, or unrelated conversation (obvious secrets are redacted). " +
        "Similar existing documents are detected; prefer update_knowledge for improvements.",
      inputSchema: {
        title: z.string().trim().min(5).max(200).describe("Specific, searchable title."),
        problem: z.string().trim().min(10).max(20_000).describe("The original task, question, or issue, with exact error text."),
        solution: z.string().trim().min(10).max(50_000).describe("The final, reusable answer or fix."),
        context: z.string().max(20_000).optional().describe("Environment, versions, constraints, assumptions, decisions."),
        implementation: z.string().max(80_000).optional().describe("Reusable code, commands, SQL, or configuration."),
        reasoning_summary: z.string().max(10_000).optional().describe("Key conclusions and rationale, not hidden chain-of-thought."),
        validation: validationSchema.optional(),
        follow_up: z.string().max(10_000).optional().describe("Unresolved issues and recommended next steps."),
        summary: z.string().max(400).optional().describe("One or two sentences shown in search results (auto-extracted if omitted)."),
        tags: tagsSchema.optional(),
        category: categorySchema.optional().describe("e.g. troubleshooting, how-to, decision, reference."),
        namespace: namespaceSchema.optional().describe("Project namespace (server default if omitted)."),
        visibility: visibilitySchema.optional().describe("private (owner only), shared (your organization), public (admins only)."),
        on_duplicate: z
          .enum(ON_DUPLICATE_ACTIONS)
          .optional()
          .describe("If similar knowledge exists: return_existing (default), create_new, or update_existing (merge)."),
        source_client: z.string().max(64).optional().describe("Client name; defaults to the connected client's name."),
        source_metadata: z
          .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))
          .optional()
          .describe("Small, non-sensitive metadata such as model or repository name."),
        measured_tokens_used: z.coerce
          .number()
          .int()
          .min(0)
          .max(100_000_000)
          .optional()
          .describe("Actual tokens the original task used, only if your client reports usage."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runTool(ctx, "save_knowledge", async (identity) => {
        const result = await ctx.services.storage.save(identity, {
          title: args.title,
          problem: args.problem,
          solution: args.solution,
          context: args.context,
          implementation: args.implementation,
          reasoningSummary: args.reasoning_summary,
          validation: args.validation,
          followUp: args.follow_up,
          summary: args.summary,
          tags: args.tags,
          category: args.category,
          namespace: args.namespace,
          visibility: args.visibility,
          onDuplicate: args.on_duplicate ?? "return_existing",
          sourceClient: args.source_client ?? connectedClientName(ctx),
          sourceMetadata: args.source_metadata,
          measuredTokensUsed: args.measured_tokens_used,
        });
        return textResult([describeSave(result), ...formatWriteNotes(result)].join("\n"));
      }),
  );
}

function describeSave(result: SaveResult): string {
  switch (result.status) {
    case "created": {
      const doc = result.document;
      return `Saved ${doc.id} v1 (${doc.visibility}, ns:${doc.namespace}, ${doc.verificationStatus}). Reference this knowledge_id instead of resending the content.`;
    }
    case "duplicate": {
      const existing = result.existing;
      return (
        `Not saved: identical knowledge already exists as ${existing.id} v${existing.version} "${singleLine(existing.title)}". ` +
        `Reuse it; to add details call update_knowledge with knowledge_id=${existing.id} and expected_version=${existing.version}.`
      );
    }
    case "possible_duplicate":
      return [
        "Not saved yet: similar knowledge already exists:",
        ...result.candidates.map(
          (candidate) =>
            `- ${candidate.id} v${candidate.version} "${singleLine(candidate.title)}" (similarity ${candidate.score.toFixed(2)}, ns:${candidate.namespace})`,
        ),
        'To extend one, call update_knowledge with its knowledge_id and expected_version. To keep a separate document, call save_knowledge again with on_duplicate="create_new".',
      ].join("\n");
    case "merged":
      return `Merged into existing ${result.document.id}, now v${result.document.version} (changed: ${result.changed.join(", ")}).`;
  }
}
