# Operations

## Identities

- The bootstrap admin (`MCP_AUTH_USER_ID`, default `owner`, in `MCP_AUTH_ORG_ID`) is created by `npm run migrate` and at
  server start. `MCP_AUTH_TOKEN` authenticates as this user; rotate it by changing the variable and restarting.
- Personal tokens: `npm run admin -- token:create <user>`; revoke with `token:revoke <token-id>` (takes effect within
  about a minute because of the authentication cache).
- Roles: `admin` (moderates shared/public documents in its organization, may publish public), `member`, `reader`
  (read and feedback only). `--public-read` lets a user read other organizations' public documents.
- Disable a user with `user:disable`; their documents remain and stay attributed.

## Retention and deletion

- `delete_knowledge` archives by default; archived documents are purged after `ARCHIVE_RETENTION_DAYS` (0 = never).
  `mode=delete` removes the document and its history immediately.
- The audit log keeps metadata only (ids, versions, counts, short reasons) and is purged after `AUDIT_RETENTION_DAYS`.

## Monitoring

- `GET /healthz` (process alive) and `GET /readyz` (database reachable and schema migrated) for probes.
- JSON logs on stderr; set `LOG_LEVEL=debug` for per-tool timings. Tokens, passwords, and database URLs are redacted
  from log fields, and document content is never logged.
- `knowledge_stats` reports searches, hit rate, cache hit rate, average latency, saves, duplicates avoided, reuse,
  and estimated vs. measured token savings. Raw counters are in the `usage_daily` table.

## Upgrades and migrations

Migrations live in `src/database/migrations/` as ordered TypeScript modules. They run in transactions under an
advisory lock (safe with several instances) and are recorded in `schema_migrations`. Never edit an applied migration;
add a new one. Run `npm run migrate` with a direct (non-pooled) connection string when your provider offers one.

## Tuning reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | 5 / 20 | Result counts. |
| `SEARCH_MIN_SCORE` | 0.15 | Relevance threshold. |
| `SEARCH_CACHE_TTL_SECONDS` / `SEARCH_CACHE_MAX_ENTRIES` | 60 / 500 | Per-identity search cache (cleared on writes). |
| `DUPLICATE_SIMILARITY_THRESHOLD` | 0.6 | Near-duplicate sensitivity. |
| `STALE_AFTER_DAYS` | 365 | Age after which results are marked stale. |
| `RATE_LIMIT_PER_MINUTE` | 120 | Per-user request budget (0 disables). |
| `REQUEST_TIMEOUT_MS` / `TOOL_TIMEOUT_MS` / `DB_QUERY_TIMEOUT_MS` | 30000 / 20000 / 15000 | Timeouts. |
| `MAX_REQUEST_BYTES` / `MAX_DOCUMENT_BYTES` | 1 MiB / 100 KiB | Size limits. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | 30 | Idle HTTP sessions are closed. |
| `ALLOWED_ORIGINS` | empty | Browser origins allowed to call the server. |
| `TRUST_PROXY` / `REQUIRE_HTTPS` | false / false | Enable both behind a TLS-terminating proxy. |
| `DATABASE_SSL` | auto | `auto` honors `sslmode` in the URL; `require`, `no-verify`, `disable` override it. |
| `REDACT_EMAILS` | true | Email redaction before persistence. |
