#!/usr/bin/env bash
# Runs ON the VM. .github/workflows/deploy.yml pipes this script over SSH, preceded by exported
# UKM_IMAGE, SOURCE_SHA, GHCR_USER, GHCR_TOKEN (short-lived workflow token) and optional APP_DIR.
set -euo pipefail

APP_DIR="${APP_DIR:-}"
APP_DIR="${APP_DIR:-$HOME/universal-knowledge-mcp}"
: "${UKM_IMAGE:?UKM_IMAGE is required}"
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.prod.yml)

cd "$APP_DIR"
if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; create it first (see docs/DEPLOYMENT.md)." >&2
  exit 1
fi

echo "Updating deployment files to ${SOURCE_SHA:-origin/main}"
git fetch --quiet origin
git merge --ff-only --quiet "${SOURCE_SHA:-origin/main}"

echo "Pinning ${UKM_IMAGE} in .env"
if grep -q '^UKM_IMAGE=' .env; then
  sed -i "s|^UKM_IMAGE=.*|UKM_IMAGE=${UKM_IMAGE}|" .env
else
  printf '\nUKM_IMAGE=%s\n' "$UKM_IMAGE" >> .env
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "${GHCR_USER:?}" --password-stdin >/dev/null
fi
"${COMPOSE[@]}" pull server
if [ -n "${GHCR_TOKEN:-}" ]; then docker logout ghcr.io >/dev/null || true; fi
"${COMPOSE[@]}" up -d --no-build --remove-orphans

echo "Waiting for /readyz"
for _ in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T server node -e \
    "fetch('http://127.0.0.1:3000/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    echo "Deployed ${UKM_IMAGE}"
    docker image prune -f >/dev/null || true
    exit 0
  fi
  sleep 2
done

echo "The server did not become ready. Recent logs:" >&2
"${COMPOSE[@]}" logs --tail=80 server >&2
exit 1
