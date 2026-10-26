import type { Migration } from "./index.js";

const SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  org_id          TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'reader')),
  can_read_public BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_id_format CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT users_org_format CHECK (org_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
);
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                      TEXT PRIMARY KEY,
  org_id                  TEXT NOT NULL,
  namespace               TEXT NOT NULL,
  owner_id                TEXT NOT NULL REFERENCES users (id),
  title                   TEXT NOT NULL,
  slug                    TEXT NOT NULL,
  category                TEXT NOT NULL DEFAULT 'general',
  visibility              TEXT NOT NULL CHECK (visibility IN ('private', 'shared', 'public')),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  verification_status     TEXT NOT NULL DEFAULT 'unverified'
                          CHECK (verification_status IN ('verified', 'partially_verified', 'unverified', 'failed')),
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  summary                 TEXT NOT NULL,
  keywords                TEXT NOT NULL DEFAULT '',
  sections                JSONB NOT NULL,
  content_md              TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  risk_flags              TEXT[] NOT NULL DEFAULT '{}',
  source_client           TEXT,
  source_metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_effort_tokens INTEGER NOT NULL DEFAULT 0,
  measured_effort_tokens  INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at             TIMESTAMPTZ,
  search_vector           TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A')
   || setweight(to_tsvector('english', coalesce(keywords, '')), 'A')
   || setweight(to_tsvector('english', coalesce(sections ->> 'problem', '')), 'B')
   || setweight(to_tsvector('english', coalesce(summary, '')), 'B')
   || setweight(to_tsvector('english', coalesce(sections ->> 'solution', '')), 'C')
   || setweight(to_tsvector('english', coalesce(sections ->> 'context', '')), 'D')
   || setweight(to_tsvector('english', left(coalesce(sections ->> 'implementation', ''), 20000)), 'D')
  ) STORED
);
CREATE INDEX IF NOT EXISTS knowledge_documents_search_idx ON knowledge_documents USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS knowledge_documents_title_trgm_idx ON knowledge_documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS knowledge_documents_scope_idx ON knowledge_documents (org_id, status, visibility);
CREATE INDEX IF NOT EXISTS knowledge_documents_namespace_idx ON knowledge_documents (org_id, namespace, status);
CREATE INDEX IF NOT EXISTS knowledge_documents_owner_idx ON knowledge_documents (owner_id, status);
CREATE INDEX IF NOT EXISTS knowledge_documents_slug_idx ON knowledge_documents (org_id, slug);
CREATE INDEX IF NOT EXISTS knowledge_documents_fingerprint_idx ON knowledge_documents (fingerprint);
CREATE INDEX IF NOT EXISTS knowledge_documents_updated_idx ON knowledge_documents (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_public_idx ON knowledge_documents (status) WHERE visibility = 'public';

CREATE TABLE IF NOT EXISTS knowledge_versions (
  document_id         TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  title               TEXT NOT NULL,
  sections            JSONB NOT NULL,
  content_md          TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  change_summary      TEXT NOT NULL,
  changed_by          TEXT NOT NULL REFERENCES users (id),
  source_client       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version)
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);
CREATE INDEX IF NOT EXISTS document_tags_tag_idx ON document_tags (tag);

CREATE TABLE IF NOT EXISTS document_grants (
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  grantee_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission  TEXT NOT NULL CHECK (permission IN ('read', 'write')),
  granted_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS document_grants_grantee_idx ON document_grants (grantee_id);

-- Hot, frequently updated counters live apart from the wide document row.
CREATE TABLE IF NOT EXISTS document_stats (
  document_id       TEXT PRIMARY KEY REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  helpful_count     INTEGER NOT NULL DEFAULT 0,
  outdated_count    INTEGER NOT NULL DEFAULT 0,
  incorrect_count   INTEGER NOT NULL DEFAULT 0,
  irrelevant_count  INTEGER NOT NULL DEFAULT 0,
  retrieval_count   INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS knowledge_feedback (
  document_id           TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  outcome               TEXT NOT NULL
                        CHECK (outcome IN ('solved', 'partially_solved', 'outdated', 'incorrect', 'irrelevant')),
  comment               TEXT,
  measured_tokens_saved INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    TEXT,
  action      TEXT NOT NULL,
  document_id TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx ON audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS audit_log_document_idx ON audit_log (document_id);

CREATE TABLE IF NOT EXISTS usage_daily (
  day    DATE NOT NULL,
  org_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, org_id, metric)
);
`;

export const initialSchema: Migration = {
  id: "001_initial_schema",
  description: "Users, tokens, knowledge documents, versions, tags, grants, stats, feedback, audit log, usage",
  async up(tx) {
    await tx.query(SQL);
  },
};
