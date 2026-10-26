# Troubleshooting

## Configuration errors at startup

The server prints one line per problem, for example `DATABASE_URL is required` or
`MCP_AUTH_TOKEN must be at least 32 characters long`, and exits with code 1. Fix the variable named in the message.
When an AI client launches the server over stdio, environment variables must be set in the client's MCP `env` block,
or in a `.env` file referenced with `ENV_FILE=/absolute/path/.env`.

## Database connections

| Symptom | Likely cause and fix |
| --- | --- |
| Tools reply "Knowledge store unavailable" | The database is unreachable, paused, or sleeping. Check `/readyz`, the host and port, firewall rules, and resume or restore free-tier databases. |
| "pending migration(s)" or "schema is missing" | Run `npm run migrate` (or set `AUTO_MIGRATE=true`). |
| `could not open extension control file ... pg_trgm` | Ask your provider to enable `pg_trgm`, or run `CREATE EXTENSION pg_trgm;` as the database owner. |
| SSL or certificate errors | Use the provider's URL with `sslmode=require`; for self-signed certificates, set `DATABASE_SSL=no-verify` only on trusted networks. |
| `too many connections` | Lower `DB_POOL_MAX` and use the pooled connection string. |
| Password with special characters rejected | URL-encode it (for example `@` → `%40`). |

## Authentication

| Symptom | Fix |
| --- | --- |
| HTTP 401 | Send `Authorization: Bearer <token>`. Personal tokens start with `ukm_`; check `npm run admin -- token:list <user>` for revoked or expired tokens. |
| HTTP 403 "Origin not allowed" | A browser-based client sent an `Origin` header. Add that origin to `ALLOWED_ORIGINS`. |
| HTTP 403 "session belongs to a different identity" | A session id was reused with another token. Reconnect. |
| HTTP 429 | Rate limit reached; wait for `Retry-After`, or raise `RATE_LIMIT_PER_MINUTE`. |
| stdio "token is not valid" | `MCP_USER_TOKEN` was revoked or expired, or the user was disabled. |

## Transport

| Symptom | Fix |
| --- | --- |
| HTTP 404 "Session not found" after a restart or cold start | Clients should re-initialize automatically. If yours does not, set `MCP_HTTP_SESSIONS=stateless`. |
| Streaming responses hang behind a proxy | Disable response buffering for `/mcp` (Caddy: `flush_interval -1`; nginx: `proxy_buffering off`). |
| Garbled stdio output | Nothing else may print to stdout. Server logs go to stderr; wrapper scripts must not `echo` to stdout. |
| HTTP 400 "HTTPS is required" | Behind a proxy, set `TRUST_PROXY=true` so `X-Forwarded-Proto` is honored, or disable `REQUIRE_HTTPS` locally. |

## Tool discovery

- Restart the client after editing its configuration. Most clients load MCP servers only at startup.
- Use absolute paths, and run `npm run build` so `dist/server/stdio.js` exists.
- Test outside the client with the MCP Inspector (`npx @modelcontextprotocol/inspector`).
- If the agent never calls `search_knowledge`, add [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md) to its persistent
  instructions; some clients ignore server-provided instructions.

## Search quality

- No results: lower `min_score`, remove filters, or search by the exact error text. New documents are visible
  immediately (the cache is cleared on every write).
- Too many weak results: raise `SEARCH_MIN_SCORE`, add tags when saving, and use namespaces per project.
- For paraphrase matching, enable optional semantic search (`EMBEDDINGS_URL`, `EMBEDDINGS_MODEL`, and pgvector).
