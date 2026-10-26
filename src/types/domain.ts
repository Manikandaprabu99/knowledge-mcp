/** Lowercase identifier used for user ids, org ids, and namespaces. */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const VISIBILITIES = ["private", "shared", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const ROLES = ["admin", "member", "reader"] as const;
export type Role = (typeof ROLES)[number];

export const VERIFICATION_STATUSES = ["verified", "partially_verified", "unverified", "failed"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DOCUMENT_STATUSES = ["active", "archived"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const FEEDBACK_OUTCOMES = ["solved", "partially_solved", "outdated", "incorrect", "irrelevant"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const ON_DUPLICATE_ACTIONS = ["return_existing", "create_new", "update_existing"] as const;
export type OnDuplicate = (typeof ON_DUPLICATE_ACTIONS)[number];

export const SECTION_KEYS = [
  "problem",
  "context",
  "solution",
  "implementation",
  "reasoning_summary",
  "validation",
  "follow_up",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type OptionalSectionKey = Exclude<SectionKey, "problem" | "solution">;

/** Structured Markdown sections; problem and solution are always present. */
export type KnowledgeSections = { problem: string; solution: string } & Partial<Record<OptionalSectionKey, string>>;

/** Authenticated caller. Never built from client-supplied ids. */
export interface Identity {
  userId: string;
  orgId: string;
  role: Role;
  canReadPublic: boolean;
  authMethod: "bootstrap_token" | "api_token";
  tokenId?: string;
}

export interface FeedbackCounts {
  helpful: number;
  outdated: number;
  incorrect: number;
  irrelevant: number;
  retrievals: number;
}

export interface KnowledgeDocument {
  id: string;
  orgId: string;
  namespace: string;
  ownerId: string;
  title: string;
  slug: string;
  category: string;
  visibility: Visibility;
  status: DocumentStatus;
  verificationStatus: VerificationStatus;
  version: number;
  summary: string;
  sections: KnowledgeSections;
  contentMd: string;
  contentHash: string;
  fingerprint: string;
  riskFlags: string[];
  tags: string[];
  sourceClient: string | null;
  estimatedEffortTokens: number;
  measuredEffortTokens: number | null;
  feedback: FeedbackCounts;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** Compact metadata returned by write operations. */
export interface DocumentHeader {
  id: string;
  title: string;
  version: number;
  namespace: string;
  category: string;
  visibility: Visibility;
  verificationStatus: VerificationStatus;
  contentHash: string;
  tags: string[];
  updatedAt: Date;
}

export function toDocumentHeader(doc: KnowledgeDocument): DocumentHeader {
  return {
    id: doc.id,
    title: doc.title,
    version: doc.version,
    namespace: doc.namespace,
    category: doc.category,
    visibility: doc.visibility,
    verificationStatus: doc.verificationStatus,
    contentHash: doc.contentHash,
    tags: doc.tags,
    updatedAt: doc.updatedAt,
  };
}
