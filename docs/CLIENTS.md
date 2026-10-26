# Client setup

MCP support differs between applications in transport, authentication, and configuration format. The snippets below
reflect the documented formats at the time of writing. **Check each client's current documentation**, because these
formats change often. Ready-to-copy files are in [`examples/`](../examples).

Two connection styles:

- **stdio (local)**: the client launches `node dist/server/stdio.js`. The process needs `DATABASE_URL` plus
  `MCP_USER_TOKEN` (personal `ukm_` token) or `MCP_AUTH_TOKEN` (single user). Use this only for trusted users, because
  anyone holding `DATABASE_URL` has full database access.
- **Streamable HTTP (remote)**: the client connects to `https://<host>/mcp` with `Authorization: Bearer <token>`.
  Users never see database credentials, so this is the right choice for teams.

Run `npm run build` first; stdio paths must be absolute. If you published the package to npm, you can replace
`node /abs/path/dist/server/stdio.js` with `npx -y universal-knowledge-mcp` ([PUBLISHING.md](PUBLISHING.md)).

## Claude Code

Docs: <https://docs.claude.com/en/docs/claude-code/mcp>

```bash
# Remote (recommended for teams)
claude mcp add --transport http knowledge https://knowledge.example.com/mcp \
  --header "Authorization: Bearer $UKM_TOKEN"

# Local stdio (reads settings from the .env file next to the repo)
claude mcp add knowledge -e ENV_FILE=/home/you/universal-knowledge-mcp/.env \
  -- node /home/you/universal-knowledge-mcp/dist/server/stdio.js

claude mcp list   # verify; inside Claude Code use /mcp to see status and tools
```

Project-scoped config (`.mcp.json` at the repository root, shareable through git because it reads the token from
your environment): see [`examples/claude-code.mcp.json`](../examples/claude-code.mcp.json). Add the
[agent instructions](AGENT_INSTRUCTIONS.md) to `CLAUDE.md`.

**WSL**: if you run Claude Code inside WSL, use Linux paths (`/home/...`) and run `node` from WSL. Keep the repository
on the Linux filesystem rather than under `/mnt/c` for speed.

## Claude Desktop

Docs: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config). Typical locations:
`~/Library/Application Support/Claude/` (macOS) and `%APPDATA%\Claude\` (Windows). Restart Claude Desktop after
changes.

- Local stdio: [`examples/claude-desktop.stdio.json`](../examples/claude-desktop.stdio.json)
- Windows app with the server inside WSL: [`examples/claude-desktop.wsl.json`](../examples/claude-desktop.wsl.json)
  (`wsl.exe --cd <repo>` makes the server load `<repo>/.env`; use the absolute `node` path printed by `which node`
  inside WSL, because nvm is not loaded for non-interactive commands)
- Remote HTTP server through the `mcp-remote` stdio bridge (sends the bearer header):
  [`examples/claude-desktop.remote.json`](../examples/claude-desktop.remote.json)

**claude.ai (web and mobile) custom connectors** add remote servers by URL and, as far as we know, expect OAuth or no
authentication, so this server's bearer tokens do not work there yet. Check <https://support.claude.com> for the
current connector requirements. OAuth support is on the roadmap.

## OpenAI

- **Responses API (remote MCP tool)**: the server must be reachable over public HTTPS. Pass the bearer token in
  `headers`; see [`examples/openai-responses.ts`](../examples/openai-responses.ts) and
  <https://platform.openai.com/docs/guides/tools-remote-mcp>.
- **OpenAI Agents SDK**: use its Streamable HTTP MCP server class with `url` and `headers`, or its stdio class with
  the command above. See the Agents SDK MCP documentation.
- **Codex CLI**: add an `[mcp_servers.knowledge]` entry to `~/.codex/config.toml` with `command`, `args`, and `env`
  for stdio. Remote HTTP support and its token options vary by version, so check the Codex documentation.
- **ChatGPT connectors / developer mode**: these support remote MCP servers with OAuth or no authentication, so bearer
  tokens are not supported. The same limitation as claude.ai applies.

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project): see
[`examples/cursor.mcp.json`](../examples/cursor.mcp.json). Remote entries use `url` + `headers`; Cursor can
interpolate environment variables with `${env:NAME}`.

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` with a prompted secret input: see [`examples/vscode.mcp.json`](../examples/vscode.mcp.json).

## Other MCP clients (Windsurf, Cline, Continue, Gemini CLI, ...)

Most accept either a stdio command (`node /abs/path/dist/server/stdio.js` plus environment variables) or a remote URL
with custom headers. If a client supports neither custom headers nor OAuth, use the `mcp-remote` bridge as in the
Claude Desktop remote example.

## Testing a connection

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP · URL: http://127.0.0.1:3000/mcp · Header: Authorization: Bearer <token>
# Or stdio: command `node`, args `dist/server/stdio.js`, env DATABASE_URL + MCP_AUTH_TOKEN
```

Call `save_knowledge` with a sample document, then `search_knowledge` with a paraphrase of its problem.
