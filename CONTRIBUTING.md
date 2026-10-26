# Contributing

Thanks for helping improve Universal Knowledge MCP.

1. Fork, then `npm install` (Node 22+; 24 LTS recommended).
2. Start PostgreSQL (`docker compose up -d db`) and export
   `TEST_DATABASE_URL=postgres://ukm:ukm_local_dev_password@localhost:5432/knowledge`.
   Integration tests truncate tables, so always use a disposable database.
3. Make focused changes and add tests (unit tests for pure logic, integration tests for SQL and tools).
4. Run `npm run lint && npm run typecheck && npm test` before opening a pull request.

Guidelines:

- TypeScript strict mode, no `any`, small functions, and dependency injection through `server/bootstrap.ts`.
- All SQL lives in `src/database/repositories/`, with every value passed as a bind parameter (`SqlParams`).
- Read-access rules live only in `services/access-control.ts`. Never filter permissions in tool code.
- Add migrations as new files in `src/database/migrations/`; never edit an applied migration.
- Never log or store document content, tokens, or credentials in logs or the audit table.
- Keep tool output compact; it is spent from the user's context window.
- Update `package-lock.json` only when dependencies change.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
