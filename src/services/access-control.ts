import type { Identity, Visibility } from "../types/domain.js";
import type { SqlParams } from "../utils/sql.js";

export type GrantPermission = "read" | "write";

/** The parts of a document that access decisions depend on. */
export interface AccessSubject {
  ownerId: string;
  orgId: string;
  visibility: Visibility;
}

/**
 * Read policy (single source of truth, enforced in SQL so unauthorized rows never leave the database):
 *  - owners read their own documents;
 *  - "shared" and "public" documents are readable inside the owner's organization;
 *  - "public" documents are readable by users explicitly allowed to read the public namespace;
 *  - explicit grants (read or write) allow reading any visibility.
 */
export function readablePredicate(alias: string, identity: Identity, params: SqlParams): string {
  const user = params.add(identity.userId);
  const org = params.add(identity.orgId);
  const publicAccess = params.add(identity.canReadPublic);
  return `(
    ${alias}.owner_id = ${user}::text
    OR (${alias}.visibility IN ('shared', 'public') AND ${alias}.org_id = ${org}::text)
    OR (${alias}.visibility = 'public' AND ${publicAccess}::boolean)
    OR EXISTS (SELECT 1 FROM document_grants g WHERE g.document_id = ${alias}.id AND g.grantee_id = ${user}::text)
  )`;
}

/** TypeScript mirror of readablePredicate for documents that were loaded by id. */
export function canRead(identity: Identity, doc: AccessSubject, grant: GrantPermission | null): boolean {
  if (doc.ownerId === identity.userId || grant !== null) return true;
  if (doc.visibility !== "private" && doc.orgId === identity.orgId) return true;
  return doc.visibility === "public" && identity.canReadPublic;
}

/**
 * Write policy:
 *  - readers never write;
 *  - owners and write-grantees can update;
 *  - "shared" documents are collaborative inside their organization (history is preserved);
 *  - "public" documents are maintained by their owner or an org admin.
 */
export function canWrite(identity: Identity, doc: AccessSubject, grant: GrantPermission | null): boolean {
  if (identity.role === "reader") return false;
  if (doc.ownerId === identity.userId || grant === "write") return true;
  if (doc.orgId !== identity.orgId) return false;
  if (doc.visibility === "shared") return true;
  return doc.visibility === "public" && identity.role === "admin";
}

/** Archive/delete: owners, or org admins for non-private documents. */
export function canDelete(identity: Identity, doc: AccessSubject): boolean {
  if (identity.role === "reader") return false;
  if (doc.ownerId === identity.userId) return true;
  return identity.role === "admin" && doc.orgId === identity.orgId && doc.visibility !== "private";
}

/** Only owners (or org admins for non-private documents) may change who can see a document. */
export function canChangeVisibility(identity: Identity, doc: AccessSubject, next: Visibility): string | null {
  if (next === "public" && identity.role !== "admin") return "Only organization admins can publish public knowledge.";
  if (doc.ownerId === identity.userId) return null;
  if (identity.role === "admin" && doc.orgId === identity.orgId && doc.visibility !== "private") return null;
  return "Only the owner (or an org admin for shared/public documents) can change visibility.";
}

/** Returns a denial reason, or null when the identity may create a document with this visibility. */
export function createDenialReason(identity: Identity, visibility: Visibility): string | null {
  if (identity.role === "reader") return "Your role is read-only, so you cannot save knowledge.";
  if (visibility === "public" && identity.role !== "admin") {
    return "Only organization admins can publish public knowledge. Save it as shared or private instead.";
  }
  return null;
}
