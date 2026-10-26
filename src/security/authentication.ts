import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Identity } from "../types/domain.js";
import { generateOpaqueId } from "../utils/ids.js";
import { LruCache } from "../utils/lru-cache.js";

export const API_TOKEN_PREFIX = "ukm_";
export const API_TOKEN_PATTERN = /^ukm_[A-Za-z0-9_-]{32,128}$/;

/** Looks up an active user by the SHA-256 hash of an API token. */
export interface IdentityLookup {
  findIdentityByTokenHash(tokenHash: string): Promise<Identity | null>;
}

export interface AuthenticatorConfig {
  authToken: string | undefined;
  authUserId: string;
  authOrgId: string;
  cacheTtlMs?: number;
}

/**
 * Resolves bearer tokens to stable identities.
 * - MCP_AUTH_TOKEN maps to the bootstrap admin identity (compared in constant time).
 * - Personal ukm_ tokens are stored only as SHA-256 hashes and resolved through the database.
 * Successful lookups are cached briefly, so a revoked token stops working within the cache TTL.
 */
export class Authenticator {
  private readonly cache: LruCache<Identity>;

  constructor(
    private readonly config: AuthenticatorConfig,
    private readonly lookup: IdentityLookup,
  ) {
    this.cache = new LruCache<Identity>(1_000, config.cacheTtlMs ?? 60_000);
  }

  async authenticate(token: string | undefined): Promise<Identity | null> {
    const candidate = token?.trim();
    if (!candidate) return null;
    if (this.config.authToken && safeEqual(candidate, this.config.authToken)) return this.bootstrapIdentity();
    if (!API_TOKEN_PATTERN.test(candidate)) return null;

    const tokenHash = hashToken(candidate);
    const cached = this.cache.get(tokenHash);
    if (cached) return cached;
    const identity = await this.lookup.findIdentityByTokenHash(tokenHash);
    if (identity) this.cache.set(tokenHash, identity);
    return identity;
  }

  bootstrapIdentity(): Identity {
    return {
      userId: this.config.authUserId,
      orgId: this.config.authOrgId,
      role: "admin",
      canReadPublic: true,
      authMethod: "bootstrap_token",
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateApiToken(): { token: string; tokenId: string; tokenHash: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenId: generateOpaqueId("tok", 16), tokenHash: hashToken(token) };
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value.trim());
  return match?.[1];
}

/** Constant-time string comparison that does not leak length through early exit. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
