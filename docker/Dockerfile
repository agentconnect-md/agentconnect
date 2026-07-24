# syntax=docker/dockerfile:1.7

#
# Unified image build for the deployable services. The build context is the repo
# root; pick a service with --target:
#
#   docker build -f docker/Dockerfile --target control-plane -t control-plane .
#   docker build -f docker/Dockerfile --target web           -t web .
#
# Both services share one builder pipeline (base tools → workspace manifests →
# per-service install + build), so their common layers are built once and cached.
#
# Control Plane — Fastify BFF + daemon WS gateway (packages/control-plane). The
#   runtime carries only the schema/migration files needed by an external
#   migration runner; it deliberately contains no Prisma CLI.
# Web console — Next.js (packages/web).

# ───────────────────────────────── base ─────────────────────────────────────
# Slim is enough for the builder: the only source-compiled native dep
# (better-sqlite3, a transitive dep of prisma we never use at runtime) has its
# build disabled in pnpm-workspace.yaml (allowBuilds), and every other approved
# build (prisma engines, sharp, esbuild, unrs-resolver) ships a prebuilt binary —
# so no node-gyp toolchain is needed.
FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# Resilient registry fetches — slow/flaky npmjs responses otherwise abort install.
RUN printf 'fetch-retries=5\nfetch-retry-maxtimeout=600000\nfetch-retry-mintimeout=20000\nfetch-timeout=600000\nnetwork-concurrency=8\n' >> /root/.npmrc

# ─────────────────────────────── manifests ──────────────────────────────────
# Workspace manifests only. The pnpm install layer downstream depends solely on
# these, so it (including native postinstall downloads) stays a cache HIT across
# code-only changes instead of reinstalling on every commit. `scripts/` is needed
# by the root `prepare` hook.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.mjs ./
COPY scripts/ scripts/
COPY packages/protocol/package.json packages/protocol/
COPY packages/connection/package.json packages/connection/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/daemon/package.json packages/daemon/
COPY packages/relay/package.json packages/relay/
COPY packages/memory-plugin-mem0/package.json packages/memory-plugin-mem0/
COPY packages/web/package.json packages/web/

# ─────────────────── control-plane: production dependencies ────────────────
# This layer depends only on manifests, so normal source changes reuse it. The
# pnpm hook removes Prisma's build-time optional peers while preserving real
# optional runtime packages (notably Resvg's native binding).
FROM manifests AS cp-prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile --filter "@agentconnect.md/control-plane..."

# ───────────────────────── control-plane: build ─────────────────────────────
FROM manifests AS cp-builder
# Install only the control-plane and its workspace deps (skips the daemon and
# its native better-sqlite3 build entirely).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/control-plane..."

# Source last — editing app code no longer busts the install layer above.
COPY . .

RUN pnpm --filter "@agentconnect.md/control-plane" prisma:generate

# protocol → control-plane (topological).
# Prisma was generated above; skip the control-plane package's prebuild hook.
RUN pnpm --config.enable-pre-post-scripts=false \
  --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/control-plane" \
  -r build

# ──────────────────────── control-plane: runtime ────────────────────────────
FROM node:24-bookworm-slim AS control-plane
WORKDIR /app/packages/control-plane
ENV NODE_ENV=production \
  PORT=8080 \
  HOST=0.0.0.0

# ca-certificates: outbound TLS to Postgres/OIDC.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production-only dependency graph plus the two built workspace packages. Keep
# their pnpm symlink layout: package node_modules resolve into /app/node_modules.
COPY --from=cp-prod-deps /app/node_modules /app/node_modules
COPY --from=cp-prod-deps /app/packages/protocol/node_modules /app/packages/protocol/node_modules
COPY --from=cp-prod-deps /app/packages/control-plane/node_modules /app/packages/control-plane/node_modules
COPY --from=cp-builder /app/packages/protocol/package.json /app/packages/protocol/package.json
COPY --from=cp-builder /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=cp-builder /app/packages/control-plane/package.json /app/packages/control-plane/package.json
COPY --from=cp-builder /app/packages/control-plane/dist /app/packages/control-plane/dist
# A schema-export init container uses this same image and copies these small,
# version-matched migration inputs to a shared volume for the generic CLI image.
COPY packages/control-plane/prisma/schema.prisma /app/packages/control-plane/prisma/schema.prisma
COPY packages/control-plane/prisma/migrations /app/packages/control-plane/prisma/migrations

EXPOSE 8080
CMD ["node", "dist/index.js"]

# ───────────────────────────── relay: build ─────────────────────────────────
# The unified ingress plane (packages/relay). No Prisma — the relay holds no
# database. Pulls only protocol + connection + relay (skips CP/daemon/web).
FROM manifests AS relay-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/relay..."

COPY . .

# protocol → connection → relay (topological).
RUN pnpm --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/connection" \
  --filter "@agentconnect.md/relay" \
  -r build

# ───────────────────────────── relay: runtime ───────────────────────────────
FROM node:24-bookworm-slim AS relay
WORKDIR /app/packages/relay
ENV NODE_ENV=production \
  PORT=8080 \
  HOST=0.0.0.0

# ca-certificates: outbound TLS to the control-plane (rc/* control wire).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Whole installed+built workspace (preserves pnpm symlinks to protocol/connection).
COPY --from=relay-builder /app /app

EXPOSE 8080
CMD ["node", "dist/index.js"]

# ────────────────────────────── web: build ──────────────────────────────────
FROM manifests AS web-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/web..."

COPY . .

# NEXT_PUBLIC_CP_URL is baked to the same-origin "/cp/api/v1" base so the browser
# calls the versioned Control Plane API through the shared ingress host (path
# /cp/* → CP, which serves its routes under /api/v1). This is a build-time
# FALLBACK only: the deploy injects CP_URL at runtime (window.__AC_ENV), so one
# image serves test and prod. Social login (Logto) config is NOT baked either —
# it's injected at runtime from container env via src/lib/public-env.tsx.
# Build fingerprint baked into the bundle (see packages/web/next.config.mjs). .git
# is dropped from the context, so the release version and git sha are passed as
# build args; CI sets them to the effective image tag and its source commit.
ARG APP_VERSION=""
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV NEXT_PUBLIC_CP_URL=/cp/api/v1 \
  APP_VERSION=$APP_VERSION \
  GIT_SHA=$GIT_SHA \
  BUILD_TIME=$BUILD_TIME
# Keep the runtime copy stable when an application has no public assets yet.
RUN mkdir -p packages/web/public \
  && pnpm --filter "@agentconnect.md/web" build

# ───────────────────────────── web: runtime ─────────────────────────────────
FROM node:24-bookworm-slim AS web
WORKDIR /app/packages/web
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=8080 \
  HOSTNAME=0.0.0.0

# Next's standalone output contains only traced production dependencies. Static
# and public assets are intentionally separate, so copy them beside server.js.
COPY --from=web-builder /app/packages/web/.next/standalone /app
COPY --from=web-builder /app/packages/web/.next/static /app/packages/web/.next/static
COPY --from=web-builder /app/packages/web/public /app/packages/web/public

EXPOSE 8080
CMD ["node", "server.js"]

# ───────────────── memory-plugin-mem0 (wrapper): prod deps ───────────────────
# The centralized external-memory wrapper (packages/memory-plugin-mem0) served in
# HTTP mode — an MCP server that forwards to a Mem0 backend. Depends only on
# protocol + external libs (no Prisma, no daemon/connection).
FROM manifests AS mem0-prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile --filter "@agentconnect.md/memory-plugin-mem0..."

# ───────────────── memory-plugin-mem0 (wrapper): build ───────────────────────
FROM manifests AS mem0-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/memory-plugin-mem0..."

COPY . .

# protocol → memory-plugin-mem0 (topological).
RUN pnpm --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/memory-plugin-mem0" \
  -r build

# ───────────────── memory-plugin-mem0 (wrapper): runtime ─────────────────────
FROM node:24-bookworm-slim AS mem0
WORKDIR /app/packages/memory-plugin-mem0
# HTTP (remote) mode is the deployable shape; each request carries its own
# X-Mem0-Api-Key, so no credential is baked in. PORT matches the chart's mem0.port.
ENV NODE_ENV=production \
  PORT=8788 \
  HOST=0.0.0.0 \
  MCP_TRANSPORT=http \
  MEM0_DIALECT=oss

# ca-certificates: outbound TLS to the Mem0 backend when it is served over https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production-only dependency graph plus the two built workspace packages. Keep the
# pnpm symlink layout: package node_modules resolve into /app/node_modules.
COPY --from=mem0-prod-deps /app/node_modules /app/node_modules
COPY --from=mem0-prod-deps /app/packages/protocol/node_modules /app/packages/protocol/node_modules
COPY --from=mem0-prod-deps /app/packages/memory-plugin-mem0/node_modules /app/packages/memory-plugin-mem0/node_modules
COPY --from=mem0-builder /app/packages/protocol/package.json /app/packages/protocol/package.json
COPY --from=mem0-builder /app/packages/protocol/dist /app/packages/protocol/dist
COPY --from=mem0-builder /app/packages/memory-plugin-mem0/package.json /app/packages/memory-plugin-mem0/package.json
COPY --from=mem0-builder /app/packages/memory-plugin-mem0/dist /app/packages/memory-plugin-mem0/dist

EXPOSE 8788
CMD ["node", "dist/cli.js"]
