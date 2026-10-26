# Security policy

## Reporting a vulnerability

Please do not open public issues for vulnerabilities. Use GitHub's private vulnerability reporting for this
repository (Security → Report a vulnerability), or contact the maintainers privately. Include steps to reproduce.

## Security model

- **Authentication**: every HTTP request needs a bearer token. `MCP_AUTH_TOKEN` is compared in constant time;
  personal `ukm_` tokens are stored only as SHA-256 hashes and can expire or be revoked. Failed attempts are
  rate-limited per address.
- **Identity**: the user is always derived from the token, never from tool arguments. HTTP sessions are bound to the
  identity that created them.
- **Authorization**: read access is enforced inside every SQL query; writes, deletes, and visibility changes are
  checked server-side. Unreadable documents are reported as "not found".
- **Input handling**: Zod validates all tool inputs and configuration; all SQL is parameterized; request and document
  sizes are limited; tool calls and queries have timeouts.
- **Content safety**: before persistence the server strips control and invisible Unicode characters, removes active
  HTML from Markdown prose, redacts secrets and common personal data, and flags prompt-injection-like text.
  Retrieved content is wrapped in delimiters and labelled as untrusted reference material.
- **No execution**: the server never executes code, SQL, shell commands, or instructions found in stored knowledge.
- **Transport**: browser `Origin` headers are validated (DNS-rebinding protection). Run behind HTTPS in production
  (`REQUIRE_HTTPS=true`, `TRUST_PROXY=true` behind a proxy).
- **Logging and audit**: logs and the audit table contain metadata only, never document content or credentials.

## Operator responsibilities

- Keep `DATABASE_URL`, `MCP_AUTH_TOKEN`, and personal tokens in a secret manager; never commit `.env`.
- stdio mode gives the local process full database access. Use it only for trusted users; give teams the HTTP
  endpoint and personal tokens instead.
- Redaction is heuristic. Tell users not to save secrets, customer data, or personal data, and review shared or
  public knowledge.
- Back up the database regularly and apply updates to dependencies, the OS, and PostgreSQL.
