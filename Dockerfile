# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

# The build stage runs on the CI machine's own architecture; its output is pure JavaScript, so it is copied
# unchanged into the amd64 or arm64 runtime image (fast multi-arch builds, no emulation).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# The committed lockfile gives reproducible builds; the fallback only exists for the very first build.
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MCP_SERVER_PORT || process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server/http.js"]
