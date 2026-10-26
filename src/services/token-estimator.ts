/**
 * Token accounting is an ESTIMATE. The server never sees model usage, so these numbers must be
 * labeled as estimates; only values reported by a client (measured_tokens_*) count as measured.
 */
export const CHARS_PER_TOKEN = 4;

/** Assumption: producing a reusable solution cost roughly 4x its final written size (reading, tool output, reasoning). */
export const EFFORT_MULTIPLIER = 4;

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

export function estimateEffortTokens(contentMd: string): number {
  return estimateTokens(contentMd) * EFFORT_MULTIPLIER;
}

export function estimateNetSavings(effortTokens: number, tokensReturned: number): number {
  return Math.max(0, Math.round(effortTokens - tokensReturned));
}
