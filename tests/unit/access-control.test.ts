import { describe, expect, it } from "vitest";
import {
  canChangeVisibility,
  canDelete,
  canRead,
  canWrite,
  createDenialReason,
  readablePredicate,
  type AccessSubject,
} from "../../src/services/access-control.js";
import type { Identity } from "../../src/types/domain.js";
import { SqlParams } from "../../src/utils/sql.js";

const user = (overrides: Partial<Identity> = {}): Identity => ({
  userId: "alice",
  orgId: "acme",
  role: "member",
  canReadPublic: false,
  authMethod: "api_token",
  ...overrides,
});
const doc = (overrides: Partial<AccessSubject> = {}): AccessSubject => ({ ownerId: "alice", orgId: "acme", visibility: "private", ...overrides });
const bob = user({ userId: "bob" });
const carol = user({ userId: "carol", orgId: "globex" });
const admin = user({ userId: "ada", role: "admin" });

describe("access control", () => {
  it("keeps private documents to the owner and explicit grantees (admins included)", () => {
    expect(canRead(user(), doc(), null)).toBe(true);
    expect(canRead(bob, doc(), null)).toBe(false);
    expect(canRead(bob, doc(), "read")).toBe(true);
    expect(canRead(admin, doc(), null)).toBe(false);
  });

  it("shares within the organization and publishes only to permitted readers", () => {
    expect(canRead(bob, doc({ visibility: "shared" }), null)).toBe(true);
    expect(canRead(carol, doc({ visibility: "shared" }), null)).toBe(false);
    expect(canRead(carol, doc({ visibility: "public" }), null)).toBe(false);
    expect(canRead({ ...carol, canReadPublic: true }, doc({ visibility: "public" }), null)).toBe(true);
  });

  it("enforces write rules", () => {
    expect(canWrite(user({ role: "reader" }), doc(), null)).toBe(false);
    expect(canWrite(bob, doc({ visibility: "shared" }), null)).toBe(true);
    expect(canWrite(bob, doc({ visibility: "public" }), null)).toBe(false);
    expect(canWrite(admin, doc({ visibility: "public" }), null)).toBe(true);
    expect(canWrite(bob, doc(), "write")).toBe(true);
    expect(canWrite(carol, doc({ visibility: "shared" }), null)).toBe(false);
  });

  it("enforces delete, create and visibility rules", () => {
    expect(canDelete(user(), doc())).toBe(true);
    expect(canDelete(admin, doc({ visibility: "shared" }))).toBe(true);
    expect(canDelete(admin, doc())).toBe(false);
    expect(canDelete(bob, doc({ visibility: "shared" }))).toBe(false);
    expect(createDenialReason(user({ role: "reader" }), "private")).toMatch(/read-only/);
    expect(createDenialReason(user(), "public")).toMatch(/admins/);
    expect(createDenialReason(admin, "public")).toBeNull();
    expect(canChangeVisibility(bob, doc({ visibility: "shared" }), "private")).toMatch(/owner/);
    expect(canChangeVisibility(user(), doc(), "shared")).toBeNull();
    expect(canChangeVisibility(user(), doc(), "public")).toMatch(/admins/);
  });

  it("builds a fully parameterized SQL read predicate", () => {
    const params = new SqlParams();
    const sql = readablePredicate("d", user(), params);
    expect(params.values).toEqual(["alice", "acme", false]);
    expect(sql).toContain("d.owner_id = $1::text");
    expect(sql).toContain("d.org_id = $2::text");
    expect(sql).toContain("$3::boolean");
    expect(sql).not.toContain("alice");
  });
});
