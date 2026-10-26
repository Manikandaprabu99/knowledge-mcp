/**
 * Query tokenization for PostgreSQL full-text search.
 * Tokens contain only letters, digits and the characters . _ # + - (none of which are to_tsquery
 * operators), so joining them with "|" always yields a syntactically valid OR query.
 */
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_.#+-]*/gu;
const MAX_TOKENS = 24;
const MAX_TOKEN_LENGTH = 64;

export function extractSearchTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const match of query.normalize("NFKC").toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0].replace(/[._-]+$/u, "");
    if (token.length < 2 || token.length > MAX_TOKEN_LENGTH) continue;
    tokens.add(token);
    if (tokens.size >= MAX_TOKENS) break;
  }
  return [...tokens];
}

/** OR semantics favor recall for natural-language questions; ranking then rewards term coverage. */
export function buildOrTsQuery(tokens: readonly string[]): string | null {
  return tokens.length > 0 ? tokens.join(" | ") : null;
}
