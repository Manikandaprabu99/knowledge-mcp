import { randomUUID } from "node:crypto";
import type { Authenticator } from "../security/authentication.js";
import type { Identity } from "../types/domain.js";
import { AppError } from "../utils/errors.js";

/** Remembers which document versions were already returned in this session (bounded, LRU). */
export class SeenDocuments {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries = 500) {}

  has(id: string, contentHash: string): boolean {
    return this.entries.get(id) === contentHash;
  }

  mark(id: string, contentHash: string): void {
    this.entries.delete(id);
    this.entries.set(id, contentHash);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

/** Per-connection state. Identity always comes from authentication, never from tool arguments. */
export interface SessionContext {
  readonly id: string;
  readonly transport: "stdio" | "http" | "memory";
  identity(): Promise<Identity>;
  readonly seenSummaries: SeenDocuments;
  readonly seenDocuments: SeenDocuments;
}

export interface HttpSessionContext extends SessionContext {
  readonly userId: string;
  /** Refreshed on every authenticated request, so role or permission changes apply immediately. */
  setIdentity(identity: Identity): void;
}

export function createStaticSession(identity: Identity, transport: SessionContext["transport"] = "memory"): SessionContext {
  return {
    id: randomUUID(),
    transport,
    identity: async () => identity,
    seenSummaries: new SeenDocuments(),
    seenDocuments: new SeenDocuments(),
  };
}

export function createHttpSession(identity: Identity): HttpSessionContext {
  let current = identity;
  return {
    id: randomUUID(),
    transport: "http",
    identity: async () => current,
    setIdentity: (next) => {
      current = next;
    },
    get userId() {
      return current.userId;
    },
    seenSummaries: new SeenDocuments(),
    seenDocuments: new SeenDocuments(),
  };
}

/** stdio: the token from the environment is re-validated periodically so revocation takes effect. */
export function createStdioSession(auth: Authenticator, token: string, revalidateMs = 60_000): SessionContext {
  let cached: { identity: Identity; at: number } | null = null;
  return {
    id: randomUUID(),
    transport: "stdio",
    identity: async () => {
      if (cached && Date.now() - cached.at < revalidateMs) return cached.identity;
      const identity = await auth.authenticate(token);
      if (!identity) {
        throw new AppError(
          "UNAUTHENTICATED",
          "The configured MCP_USER_TOKEN / MCP_AUTH_TOKEN is not valid (unknown, revoked, expired, or the user is disabled). Issue a new token with `npm run admin -- token:create <user-id>`.",
        );
      }
      cached = { identity, at: Date.now() };
      return identity;
    },
    seenSummaries: new SeenDocuments(),
    seenDocuments: new SeenDocuments(),
  };
}
