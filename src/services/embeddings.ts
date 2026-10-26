import { z } from "zod";
import type { EmbeddingsConfig } from "../config/env.js";
import type { Database } from "../database/client.js";
import type { KnowledgeSections } from "../types/domain.js";
import { errorMessage } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int().optional() })).min(1),
});

/**
 * Optional semantic search. Uses pgvector plus any OpenAI-compatible /embeddings endpoint, including
 * free local models (e.g. Ollama). Failures never block saving or lexical search.
 */
export class EmbeddingIndex {
  private enabled = false;

  constructor(
    private readonly config: EmbeddingsConfig,
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Idempotently enables pgvector and the embeddings table when the extension is available. */
  async ensureSchema(): Promise<boolean> {
    const result = await this.db.query<{ available: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available",
    );
    if (!result.rows[0]?.available) {
      this.logger.warn("EMBEDDINGS_URL is set but pgvector is not available on this database; semantic search is disabled.");
      this.enabled = false;
      return false;
    }
    await this.db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
         document_id  TEXT PRIMARY KEY REFERENCES knowledge_documents (id) ON DELETE CASCADE,
         model        TEXT NOT NULL,
         dimensions   INTEGER NOT NULL,
         content_hash TEXT NOT NULL,
         embedding    vector NOT NULL,
         updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    this.enabled = true;
    return true;
  }

  async queryVector(text: string): Promise<{ vector: string; model: string } | null> {
    if (!this.enabled) return null;
    try {
      const [vector] = await this.embed([text.slice(0, 2_000)]);
      return vector ? { vector: toVectorLiteral(vector), model: this.config.model } : null;
    } catch (error) {
      this.logger.warn("Query embedding failed; falling back to lexical search", { reason: errorMessage(error) });
      return null;
    }
  }

  async indexDocument(doc: { id: string; title: string; sections: KnowledgeSections; contentHash: string }): Promise<void> {
    if (!this.enabled) return;
    try {
      const text = [doc.title, doc.sections.problem, doc.sections.solution].join("\n\n").slice(0, 8_000);
      const [vector] = await this.embed([text]);
      if (!vector) return;
      await this.db.query(
        `INSERT INTO knowledge_embeddings (document_id, model, dimensions, content_hash, embedding, updated_at)
         VALUES ($1, $2, $3, $4, $5::vector, now())
         ON CONFLICT (document_id) DO UPDATE SET model = EXCLUDED.model, dimensions = EXCLUDED.dimensions,
           content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding, updated_at = now()`,
        [doc.id, this.config.model, vector.length, doc.contentHash, toVectorLiteral(vector)],
      );
    } catch (error) {
      this.logger.warn("Could not index document embedding", { documentId: doc.id, reason: errorMessage(error) });
    }
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.config.url}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}`);
    const parsed = responseSchema.parse(await response.json());
    return [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
  }
}

export function toVectorLiteral(vector: readonly number[]): string {
  if (!vector.every((value) => Number.isFinite(value))) throw new Error("Embedding contains non-finite values.");
  return `[${vector.join(",")}]`;
}
