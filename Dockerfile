# Multi-stage build: client (Vue SPA) + server (Fastify), pnpm workspace
# Final image ~180MB, Node 22 Alpine

# ── Stage 1: Install all workspace deps from the root lockfile ──
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
# Only the manifests + lockfile so this layer caches across source edits
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile

# ── Stage 2: Build client (Vite) + server (tsc) ──
FROM deps AS build
WORKDIR /app
COPY client/ ./client/
COPY server/ ./server/
RUN pnpm --filter option-strategy-engine-client build \
 && pnpm --filter option-strategy-engine-server build
# Output: /app/client/dist  and  /app/server/dist

# ── Stage 3: Production-only node_modules (no symlinks, fully portable) ──
FROM deps AS prod-deps
WORKDIR /app
RUN pnpm --filter option-strategy-engine-server deploy --prod /prod

# ── Stage 4: Runtime image ──
FROM node:22-alpine
WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3001

# Production deps (fastify, @fastify/static, node-cron)
COPY --from=prod-deps /prod/node_modules ./node_modules
COPY --from=prod-deps /prod/package.json ./package.json
# Built server JS
COPY --from=build /app/server/dist ./dist
# Built client SPA — server resolves it at ../client/dist (cwd /app/server)
COPY --from=build /app/client/dist /app/client/dist

# Runtime data dirs (both persisted via named volumes in compose):
#   cache/ — API-response cache;  data/ — IV history + transcripts
RUN mkdir -p /app/server/cache /app/server/data

EXPOSE 3001

CMD ["node", "dist/index.js"]
