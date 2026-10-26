import { randomBytes } from "node:crypto";

/** Crockford base32, lowercase (no i, l, o, u). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export const KNOWLEDGE_ID_PATTERN = /^kn_[0-9a-hjkmnp-tv-z]{26}$/;

/** ULID-style id: 48-bit timestamp + 80 random bits. Stable for the document's lifetime and time-sortable. */
export function generateKnowledgeId(now: number = Date.now()): string {
  return `kn_${encodeTime(now, 10)}${encodeRandom(16)}`;
}

export function generateOpaqueId(prefix: string, length = 20): string {
  return `${prefix}_${encodeRandom(length)}`;
}

function encodeTime(time: number, length: number): string {
  let remaining = Math.floor(time);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output = ALPHABET.charAt(remaining % 32) + output;
    remaining = Math.floor(remaining / 32);
  }
  return output;
}

function encodeRandom(length: number): string {
  let output = "";
  // 256 is divisible by 32, so masking keeps the distribution uniform.
  for (const byte of randomBytes(length)) output += ALPHABET.charAt(byte & 31);
  return output;
}
