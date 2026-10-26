import type { Queryable } from "../database/client.js";
import type { DocumentRepository, DuplicateRow } from "../database/repositories/document-repository.js";
import type { Identity } from "../types/domain.js";
import { normalizeForComparison, sha256Hex, titleKey } from "../utils/text.js";
import { buildOrTsQuery, extractSearchTokens } from "./search-query.js";

export interface DuplicateCandidate extends DuplicateRow {
  score: number;
}

/** Identical problem + solution (ignoring case, whitespace and punctuation) gives an identical fingerprint. */
export function computeFingerprint(problem: string, solution: string): string {
  return sha256Hex(`${normalizeForComparison(problem)}\n---\n${normalizeForComparison(solution)}`);
}

export function duplicateScore(row: Pick<DuplicateRow, "exact" | "titleSimilarity" | "problemSimilarity">): number {
  if (row.exact) return 1;
  return Math.round((0.5 * row.titleSimilarity + 0.5 * row.problemSimilarity) * 1000) / 1000;
}

/** Finds existing documents (readable by the caller only) that a new save would duplicate. */
export class DuplicateDetector {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly threshold: number,
  ) {}

  async findDuplicates(
    identity: Identity,
    input: { title: string; problem: string; fingerprint: string },
    q?: Queryable,
  ): Promise<DuplicateCandidate[]> {
    const rows = await this.documents.findDuplicateCandidates(
      identity,
      {
        fingerprint: input.fingerprint,
        slug: titleKey(input.title),
        title: input.title,
        problemExcerpt: input.problem.slice(0, 1_000),
        tsQuery: buildOrTsQuery(extractSearchTokens(`${input.title} ${input.problem.slice(0, 300)}`)),
      },
      q,
    );
    return rows
      .map((row) => ({ ...row, score: duplicateScore(row) }))
      .filter((candidate) => candidate.exact || candidate.score >= this.threshold)
      .sort((a, b) => b.score - a.score);
  }
}
