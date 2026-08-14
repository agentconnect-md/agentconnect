# syntax=docker/dockerfile:1.7

#
# Unified image build for the deployable services. The build context is the repo
# root; pick a service with --target:
#
#   docker build -f docker/Dockerfile --target control-plane -t control-plane .
#   docker build -f docker/Dockerfile --target relay         -t relay .
#   docker build -f docker/Dockerfile --target mem0          -t mem0 .
#   docker build -f docker/Dockerfile --target web           -t web .
#
# The plain Node services share one pipeline (base tools → workspace manifests →
# per-service install + build → portable production deploy). Web uses Next's
# standalone output; all targets still share the base and manifest layers.
#
# Control Plane — Fastify BFF + daemon WS gateway (packages/control-plane). The
#   runtime also carries schema/migration files for the external migration
#   runner and the self-contained Setup Server;
#   it deliberately contains no Prisma CLI.
# Relay — shared integration ingress (packages/relay).
# Memory plugin — centralized Mem0 MCP wrapper (packages/memory-plugin-mem0).
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
COPY packages/activation-policy/package.json packages/activation-policy/
COPY packages/message/package.json packages/message/
COPY packages/protocol/package.json packages/protocol/
COPY packages/connection/package.json packages/connection/
COPY packages/observability/package.json packages/observability/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/setup/package.json packages/setup/
COPY packages/daemon/package.json packages/daemon/
COPY packages/relay/package.json packages/relay/
COPY packages/memory-plugin-mem0/package.json packages/memory-plugin-mem0/
COPY packages/web/package.json packages/web/
COPY packages/k8s-client/package.json packages/k8s-client/

# ───────────────────────── control-plane: build ─────────────────────────────
# Install the control-plane, the self-contained Setup Server package, and
# their workspace deps (skips the daemon and its native better-sqlite3 build).
FROM manifests AS cp-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile \
  --filter "@agentconnect.md/control-plane..." \
  --filter "@agentconnect.md/setup..."

# Source last — editing app code no longer busts the install layer above.
COPY . .

RUN pnpm --filter "@agentconnect.md/control-plane" prisma:generate

# protocol + observability → control-plane (topological).
# Prisma was generated above; skip the control-plane package's prebuild hook.
RUN pnpm --config.enable-pre-post-scripts=false \
  --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/observability" \
  --filter "@agentconnect.md/connection" \
  --filter "@agentconnect.md/k8s-client" \
  --filter "@agentconnect.md/control-plane" \
  -r build

# Bundle the Setup Server and its runtime dependencies.
RUN pnpm --filter "@agentconnect.md/setup" build

# Materialize the same portable production bundle used by the other plain Node
# services. The pnpm hook removes Prisma's build-only optional peers while
# preserving real runtime packages (notably Resvg's native binding).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --config.inject-workspace-packages=true \
  --filter "@agentconnect.md/control-plane" \
  deploy --prod /control-plane

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

# Production dependencies, built workspace packages, and the version-matched
# Prisma schema/migrations used by the schema-export init container.
COPY --from=cp-builder /control-plane ./
COPY --from=cp-builder /app/packages/setup/dist /app/packages/setup/dist
COPY --from=cp-builder /app/packages/setup/package.json /app/packages/setup/package.json

EXPOSE 8080
CMD ["node", "dist/index.js"]

# ───────────────────────────── relay: build ─────────────────────────────────
# The unified ingress plane (packages/relay). No Prisma — the relay holds no
# database. Pulls only activation-policy + message + protocol + connection +
# observability + relay (skips CP/daemon/web).
FROM manifests AS relay-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/relay..."

COPY . .

# protocol → activation-policy / message / connection / observability → relay (topological).
RUN pnpm --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/activation-policy" \
  --filter "@agentconnect.md/message" \
  --filter "@agentconnect.md/connection" \
  --filter "@agentconnect.md/observability" \
  --filter "@agentconnect.md/relay" \
  -r build

# Materialize a portable production-only package. Per-command workspace
# injection includes the built protocol/connection packages without changing
# install semantics for the rest of the monorepo.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --config.inject-workspace-packages=true \
  --filter "@agentconnect.md/relay" \
  deploy --prod /relay

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

# Production dependencies and built relay/workspace packages only.
COPY --from=relay-builder /relay ./

EXPOSE 8080
CMD ["node", "dist/index.js"]

# ──────────────────────────── daemon: build ─────────────────────────────────
# The edge unit (packages/daemon). Distinct from the RUNTIME SANDBOX image
# (docker/runtime-sandbox.Dockerfile): this runs the daemon, that one is what an
# agent's ACP runtime executes inside. Under --k8s the daemon starts no runtime
# locally, so this image carries no ACP runtimes at all.
FROM manifests AS daemon-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/daemon..."

COPY . .

# protocol → activation-policy / message / connection / observability → daemon (topological).
RUN pnpm --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/activation-policy" \
  --filter "@agentconnect.md/message" \
  --filter "@agentconnect.md/connection" \
  --filter "@agentconnect.md/observability" \
  --filter "@agentconnect.md/daemon" \
  -r build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --config.inject-workspace-packages=true \
  --filter "@agentconnect.md/daemon" \
  deploy --prod /daemon

# ─────────────────────────── daemon: runtime ────────────────────────────────
FROM node:24-bookworm-slim AS daemon
WORKDIR /app/packages/daemon
ENV NODE_ENV=production \
  AC_K8S_SHIM_HOST=0.0.0.0 \
  AC_K8S_SHIM_PORT=8085 \
  # The kubelet is the supervisor: it restarts the container, and an in-pod
  # self-upgrade would exit for a version the cluster never asked for.
  AGENTCONNECT_SUPERVISOR=k8s

# git is load-bearing even here: a self-hosted agent on this daemon still clones
# locally, and the workspace seam only moves git into a sandbox for agents that
# have one. ca-certificates covers outbound TLS to the control plane and to
# providers (direct-connect, for now).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=daemon-builder /daemon ./

# The version this pod reports. The repo manifest stays at 1.0.0-dev and semantic-release does not
# commit a bump, so an image built from the release tag would otherwise report the dev version —
# and the Control Plane persists it as `agentVersion` for fleet and upgrade state, meaning every
# pod would identify itself wrongly. CI passes the effective image tag; the leading `v` is dropped
# because a package version is semver, not a git tag.
ARG DAEMON_VERSION=""
# Only a semver-shaped value is written: a local `bake` passes VERSION=local, and a package
# version of "local" would be a nonsense answer rather than an obviously absent one.
RUN if echo "$DAEMON_VERSION" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+'; then \
  DAEMON_VERSION="$DAEMON_VERSION" node -e "const fs=require('node:fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.env.DAEMON_VERSION.replace(/^v/,'');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"; \
  fi

# Non-root, and a fixed uid so a daemon state volume survives a rollout.
RUN groupadd --gid 10002 daemon-user \
  && useradd --uid 10002 --gid 10002 --home-dir /var/lib/agentconnect --create-home daemon-user \
  && chown -R 10002:10002 /var/lib/agentconnect
ENV HOME=/var/lib/agentconnect
USER 10002:10002

# The shim callback endpoint. Sandboxes dial IN to this; the daemon never dials
# into a sandbox, which is what lets a sandbox keep zero inbound rules.
EXPOSE 8085
# tini so a SIGTERM reaches the daemon and its drain actually runs — without it
# PID 1 ignores the signal and every rollout ends in SIGKILL mid-drain.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js", "run", "--k8s"]

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
  && pnpm --filter "@agentconnect.md/protocol" build \
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

# ───────────────── memory-plugin-mem0 (wrapper): build ───────────────────────
# The centralized external-memory wrapper (packages/memory-plugin-mem0) served in
# HTTP mode — an MCP server that forwards to a Mem0 backend. Depends only on
# protocol + external libs (no Prisma, no daemon/connection/message).
FROM manifests AS mem0-builder
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --filter "@agentconnect.md/memory-plugin-mem0..."

COPY . .

# protocol → memory-plugin-mem0 (topological).
RUN pnpm --filter "@agentconnect.md/protocol" \
  --filter "@agentconnect.md/memory-plugin-mem0" \
  -r build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --config.inject-workspace-packages=true \
  --filter "@agentconnect.md/memory-plugin-mem0" \
  deploy --prod /memory-plugin-mem0

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

# Production dependencies and built workspace packages only.
COPY --from=mem0-builder /memory-plugin-mem0 ./

EXPOSE 8788
CMD ["node", "dist/cli.js"]
