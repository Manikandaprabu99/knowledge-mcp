import { describe, expect, it } from "vitest";
import {
  API_TOKEN_PATTERN,
  Authenticator,
  extractBearerToken,
  generateApiToken,
  hashToken,
  safeEqual,
} from "../../src/security/authentication.js";
import type { Identity } from "../../src/types/domain.js";

const ADMIN_TOKEN = "admin-token-0123456789abcdefghijklmnopqrstuvwxyz";

function fakeLookup(entries: Record<string, Identity>) {
  let calls = 0;
  return {
    calls: () => calls,
    findIdentityByTokenHash: async (hash: string) => {
      calls += 1;
      return entries[hash] ?? null;
    },
  };
}

describe("authentication", () => {
  it("maps the bootstrap token to the admin identity without a database lookup", async () => {
    const lookup = fakeLookup({});
    const auth = new Authenticator({ authToken: ADMIN_TOKEN, authUserId: "owner", authOrgId: "default" }, lookup);
    const identity = await auth.authenticate(ADMIN_TOKEN);
    expect(identity?.userId).toBe("owner");
    expect(identity?.role).toBe("admin");
    expect(identity?.authMethod).toBe("bootstrap_token");
    expect(lookup.calls()).toBe(0);
  });

  it("resolves personal tokens by hash and caches the result", async () => {
    const { token, tokenHash, tokenId } = generateApiToken();
    expect(token).toMatch(API_TOKEN_PATTERN);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenId.startsWith("tok_")).toBe(true);
    const alice: Identity = { userId: "alice", orgId: "acme", role: "member", canReadPublic: false, authMethod: "api_token" };
    const lookup = fakeLookup({ [tokenHash]: alice });
    const auth = new Authenticator({ authToken: ADMIN_TOKEN, authUserId: "owner", authOrgId: "default" }, lookup);
    expect((await auth.authenticate(token))?.userId).toBe("alice");
    expect((await auth.authenticate(token))?.userId).toBe("alice");
    expect(lookup.calls()).toBe(1);
  });

  it("rejects empty, malformed and unknown tokens", async () => {
    const lookup = fakeLookup({});
    const auth = new Authenticator({ authToken: ADMIN_TOKEN, authUserId: "owner", authOrgId: "default" }, lookup);
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate("   ")).toBeNull();
    expect(await auth.authenticate("garbage")).toBeNull();
    expect(lookup.calls()).toBe(0);
    expect(await auth.authenticate(`ukm_${"z".repeat(43)}`)).toBeNull();
    expect(lookup.calls()).toBe(1);
  });

  it("parses bearer headers and compares secrets in constant time", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer   abc  ")).toBe("abc");
    expect(extractBearerToken(["Bearer first", "Bearer second"])).toBe("first");
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(safeEqual("same", "same")).toBe(true);
    expect(safeEqual("same", "diff")).toBe(false);
    expect(safeEqual("short", "longer")).toBe(false);
    expect(generateApiToken().token).not.toBe(generateApiToken().token);
  });
});
