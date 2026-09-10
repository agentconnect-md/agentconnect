# syntax=docker/dockerfile:1.7

ARG RUNTIME_SANDBOX_BASE=ghcr.io/agentconnect-md/runtime-sandbox:base-20260910.1@sha256:3da638f4707c4cb28522b3c82e3b5448c40a24d3b9723690a5cc62538dfc2296
ARG RUNTIME_SANDBOX_FULL_BASE=ghcr.io/agentconnect-md/runtime-sandbox-full:base-20260910.1@sha256:425a1558338bd2c68dc69da846ee88ca5e1bbf2d212a3bc1a65d75c4761e59c0

# Release images add daemon-versioned helpers to manually published dependency bases.

# ───────────────────────────── shim builder ─────────────────────────────────
# The shim build inlines its dependencies so runtime images need no daemon node_modules.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS shim-builder
WORKDIR /build
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH
RUN corepack enable
RUN printf 'fetch-retries=5\nfetch-retry-maxtimeout=600000\nfetch-retry-mintimeout=20000\nfetch-timeout=600000\nnetwork-concurrency=8\n' >> /root/.npmrc

# .pnpmfile.mjs is checksummed INTO the lockfile, so a frozen install without it is refused.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.mjs tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/protocol/package.json packages/protocol/
COPY packages/connection/package.json packages/connection/
COPY packages/message/package.json packages/message/
COPY packages/observability/package.json packages/observability/
COPY packages/daemon/package.json packages/daemon/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --filter @agentconnect.md/daemon... --frozen-lockfile --ignore-scripts

COPY packages/protocol packages/protocol
COPY packages/connection packages/connection
COPY packages/message packages/message
COPY packages/observability packages/observability
COPY packages/daemon packages/daemon
# Build workspace dependencies first so the shim bundle cannot leave them external.
RUN pnpm --filter "@agentconnect.md/daemon^..." build \
  && pnpm --filter @agentconnect.md/daemon run build:shim

# Set immutable modes before copying the small payload into either final image.
FROM shim-builder AS runtime-helpers
RUN mkdir -p /out/shim /out/pathbin \
  && cp /build/packages/daemon/dist/shim/*.js /out/shim/ \
  && cp -R /build/packages/daemon/dist/shim/skills /out/shim/skills \
  && cp /build/packages/daemon/dist/shim/gh /out/pathbin/gh \
  && chmod 0444 /out/shim/*.js /out/shim/skills/dist/cli.js \
    /out/shim/skills/workspace-mutation.js /out/shim/skills/package.json \
  && chmod 0555 /out/shim /out/pathbin /out/pathbin/gh

# The bases carry the installed catalog, runtime table, system tools and non-root entrypoint.
FROM ${RUNTIME_SANDBOX_FULL_BASE} AS runtime-sandbox-full
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/

# Keep the pool image as the default build target.
FROM ${RUNTIME_SANDBOX_BASE} AS runtime-sandbox
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/
