# Deployment

GitHub hosts the source code and runs CI. It does **not** run a long-lived MCP server or a PostgreSQL database. You
need a runtime host and a database host. Free tiers change often: **verify current limits on each provider's pricing
page** before relying on them. The notes below describe typical behavior, not guarantees.

## Option A: local Docker (development, zero cost)

```bash
cp .env.example .env    # set MCP_AUTH_TOKEN
docker compose up --build -d
docker compose logs -f server
```

PostgreSQL data persists in the `pgdata` volume. The server listens on `127.0.0.1:3000` only.

## Option B: always-on VM with HTTPS (Oracle Cloud Always Free or any small VPS)

A free VM can run PostgreSQL, the server, and Caddy (automatic HTTPS) with
[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml).

1. Create the VM (Ubuntu), install Docker, and open ports 80 and 443 in **both** the cloud security list and the VM
   firewall (`iptables`/`ufw`).
2. Point a DNS name (for example `knowledge.example.com`) at the VM's public IP.
3. Clone the repository, `cp .env.example .env`, then set `MCP_AUTH_TOKEN`, `POSTGRES_PASSWORD`, and
   `UKM_DOMAIN=knowledge.example.com`.
4. `docker compose --env-file .env -f deploy/docker-compose.prod.yml up --build -d` (use a URL-safe `POSTGRES_PASSWORD`, e.g. base64url)
5. Check `https://knowledge.example.com/readyz`, then create users and tokens:
   `docker compose --env-file .env -f deploy/docker-compose.prod.yml exec server node dist/cli/admin.js user:create alice --org acme`

Caddy obtains and renews TLS certificates and streams SSE responses without buffering. PostgreSQL is not exposed to
the internet. You are responsible for OS updates and backups (see below).

### Automatic deploys from GitHub to the VM

After the one-time setup below, every push to `main` that passes CI builds a Docker image for amd64 and arm64 (Oracle
Ampere A1 included), pushes it to GitHub Container Registry, connects to the VM over SSH, and restarts the server with
that exact image. The deploy only succeeds after `/readyz` reports ready. Files involved:
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) and [`deploy/remote-deploy.sh`](../deploy/remote-deploy.sh)
(runs on the VM).

1. **VM**: complete steps 1–5 above once by hand, with the repository cloned at `~/universal-knowledge-mcp` and your
   SSH user in the `docker` group (`sudo usermod -aG docker $USER`, then log in again). For a private repository, give
   the VM read access (for example a GitHub deploy key) so `git fetch` works.
2. **Deploy key**: on your computer, create a key pair and authorize it on the VM:

   ```bash
   ssh-keygen -t ed25519 -f ukm_deploy -N "" -C "github-deploy"
   ssh-copy-id -i ukm_deploy.pub ubuntu@YOUR_VM_IP
   ssh-keyscan -H YOUR_VM_IP        # output is the DEPLOY_KNOWN_HOSTS value (add -p PORT for a custom port)
   ```

3. **GitHub** → repository Settings → Secrets and variables → Actions:
   - Secrets: `DEPLOY_HOST` (VM IP or hostname), `DEPLOY_USER` (for example `ubuntu`), `DEPLOY_SSH_KEY` (the whole
     private key file `ukm_deploy`), `DEPLOY_KNOWN_HOSTS` (the `ssh-keyscan` output). Optional: `DEPLOY_PORT`,
     `DEPLOY_PATH` (if the repository is not at `~/universal-knowledge-mcp`).
   - Variable: `DEPLOY_ENABLED` = `true`. Without it the workflow is skipped (for example in forks).
4. Push to `main` and watch Actions → **Deploy**. Run it manually with *Run workflow* to redeploy.

Notes:

- The deployed image is pinned in the VM's `.env` as `UKM_IMAGE=ghcr.io/<owner>/<repo>:sha-…`, so manual
  `docker compose` commands use the same version.
- **Rollback**: set `UKM_IMAGE` in `.env` to an earlier `sha-…` tag (listed under the repository's Packages) and run
  `docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --no-build`, or revert the commit and push.
- To require approval before each production deploy, add required reviewers to the `production` environment
  (Settings → Environments).
- The registry login on the VM uses the workflow's short-lived token and logs out after pulling; no long-lived
  registry credentials are stored on the VM.

## Option C: Render (server) + Neon (database)

1. Create a Neon project with pooled and direct connection strings. Run migrations once from your machine using the
   **direct** string: `DATABASE_URL=<direct url> npm run migrate`.
2. Create a Render Blueprint from this repository using [`deploy/render.yaml`](../deploy/render.yaml) (Docker
   runtime; Render expects `render.yaml` at the repository root unless you choose another Blueprint path). Set `DATABASE_URL` to Neon's **pooled** string (it includes `sslmode=require`). `MCP_AUTH_TOKEN` is
   generated automatically; copy it from the dashboard.
3. Use `https://<service>.onrender.com/mcp` in your clients.

The blueprint sets `MCP_HTTP_SESSIONS=stateless`, `TRUST_PROXY=true`, `REQUIRE_HTTPS=true`, `AUTO_MIGRATE=true`, and
`DB_POOL_MAX=3`.

## Option D: Google Cloud Run

Build the Docker image, deploy it with `MCP_HOST=0.0.0.0`, `MCP_HTTP_SESSIONS=stateless`, `TRUST_PROXY=true`, and
`REQUIRE_HTTPS=true`, and raise the request timeout if clients keep streams open. Cloud Run's free tier requires a
billing account; pair it with Neon, Supabase, or another hosted PostgreSQL.

## Free-tier caveats

| Concern | What to expect | Mitigation built in |
| --- | --- | --- |
| Cold starts | Free web services often sleep after inactivity; the first request can take tens of seconds. | `stateless` sessions; clients reconnect; `/healthz` for keep-alive pings. |
| Database pauses / scale-to-zero | Serverless databases suspend when idle; inactive free projects may be paused until restored manually. | Background initialization retries; tools return "unavailable" errors instead of crashing. |
| Connection limits | Free databases allow few connections. | `DB_POOL_MAX` (default 5); use the provider's pooled URL for the server and the direct URL for migrations. |
| Storage limits | Typically a few hundred MB to a few GB. | Size limit per document (`MAX_DOCUMENT_BYTES`), deduplication, retention purge. |
| Database expiration | Some free databases are deleted after a fixed period unless upgraded. | Regular `pg_dump` backups; `export_knowledge` / `GET /export/<id>.md`. |
| Ephemeral filesystem | Containers lose local files on restart. | Nothing is stored on disk; everything lives in PostgreSQL. |
| Extensions | `pg_trgm` is widely available; `pgvector` is not everywhere. | Semantic search is optional and auto-detected. |

## Backups and exports

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > knowledge-$(date +%F).dump
pg_restore --no-owner --dbname "$TARGET_DATABASE_URL" knowledge-2026-10-20.dump
```

Single documents can be exported as Markdown with the `export_knowledge` tool or
`curl -H "Authorization: Bearer $UKM_TOKEN" https://<host>/export/<id>.md -o doc.md`.
