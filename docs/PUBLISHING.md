# Publishing to npm

Publishing lets people run **their own copy** with `npx`, like other MCP servers. Each copy needs its own PostgreSQL
database. It does not give anyone access to your deployed server: for that they only need your URL and a personal token
(see [CLIENTS.md](CLIENTS.md)).

The package provides four commands:

| Command | Purpose |
| --- | --- |
| `universal-knowledge-mcp` | stdio server (what `npx -y universal-knowledge-mcp` runs) |
| `universal-knowledge-mcp-http` | Streamable HTTP server |
| `universal-knowledge-mcp-admin` | users, tokens, grants |
| `universal-knowledge-mcp-migrate` | apply database migrations |

## 1. Choose the package name

The unscoped name `universal-knowledge-mcp` may already be taken (search it on npmjs.com). If so, publish under your
own scope; the command names stay the same:

```bash
npm pkg set name=@your-npm-username/universal-knowledge-mcp
```

Then update `universal-knowledge-mcp` to the new name in the README, `examples/npx.stdio.json` and below.

## 2. First release (from your computer)

```bash
npm login
npm run lint && npm run typecheck && npm test
npm pack --dry-run          # review exactly which files will be published
npm publish --access public # prepublishOnly cleans and rebuilds dist/ first
```

## 3. Later releases (automatic from GitHub)

1. Let GitHub Actions publish, using one of:
   - **Trusted publishing (no stored secret, recommended)**: on npmjs.com open the package → Settings → Trusted
     publishing, add GitHub Actions with your repository and the workflow file `publish-npm.yml`.
   - **Token**: create a granular access token with publish permission and save it as the repository secret `NPM_TOKEN`.

   npm's authentication options change over time; check <https://docs.npmjs.com/trusted-publishers> if a publish fails
   with an authentication error.
2. Bump the version. `npm version` also updates `src/version.ts` and creates the commit and tag:

   ```bash
   npm version patch          # or minor / major
   git push --follow-tags
   ```

3. On GitHub, create a release from that tag (Releases → Draft a new release → choose the tag → Publish).
   The **Publish to npm** workflow runs lint, type-check and all tests against PostgreSQL, checks that the tag matches
   `package.json`, and publishes with provenance (provenance requires a public repository).

## How people use the published package

Self-hosted stdio, for example in `claude_desktop_config.json` ([`examples/npx.stdio.json`](../examples/npx.stdio.json)):

```json
{
  "mcpServers": {
    "universal-knowledge": {
      "command": "npx",
      "args": ["-y", "universal-knowledge-mcp"],
      "env": {
        "DATABASE_URL": "postgres://ukm:change_me@localhost:5432/knowledge",
        "MCP_AUTH_TOKEN": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
        "AUTO_MIGRATE": "true"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add knowledge -e DATABASE_URL=postgres://... -e MCP_AUTH_TOKEN=... -e AUTO_MIGRATE=true \
  -- npx -y universal-knowledge-mcp
```

Admin commands without cloning the repository:

```bash
DATABASE_URL=postgres://... npx -y -p universal-knowledge-mcp universal-knowledge-mcp-admin user:create alice --org acme
```
