# Changelog

## 0.1.0 — initial release

- MCP server with stdio and Streamable HTTP transports (stateful or stateless sessions).
- Tools: search, get, save, update, list, export, delete/archive, feedback, stats; `knowledge_workflow` prompt.
- PostgreSQL schema with versions, tags, grants, stats, feedback, audit log, and usage counters; full-text and
  trigram indexes; optional pgvector semantic search.
- Token-based identities, roles, private/shared/public visibility, organizations and namespaces.
- Redaction, sanitization, prompt-injection flagging, rate limiting, Origin validation, retention.
- Docker, Compose, GitHub Actions, deployment guides, and client examples.
- npm package with four commands (stdio, HTTP, admin, migrate), release workflow with provenance, and version sync.
- Automatic deploys: multi-arch image to GitHub Container Registry, then SSH update of the VM with a readiness check.
