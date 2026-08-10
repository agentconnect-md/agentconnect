# syntax=docker/dockerfile:1.7

#
# The RUNTIME SANDBOX image — what an agent's ACP runtime executes inside.
#
# Deliberately a different image from docker/Dockerfile's service targets. Those run the
# published daemon and control-plane packages; this one runs half-trusted agent code, so it
# carries the opposite bias: the shim and nothing the shim does not need.
#
#   docker build -f docker/runtime-sandbox.Dockerfile -t runtime-sandbox .
#
# Build context is the repo root, because the shim is built from packages/daemon and versioned
# with the daemon half of the channel it speaks.
#
# Four properties this image exists to hold, each asserted by scripts/verify-runtime-image.mjs
# rather than left to review:
#   1. tini is PID 1 — a runtime that spawns children must not leave zombies, and a pod whose
#      PID 1 ignores SIGTERM is a pod that only ever dies by SIGKILL.
#   2. The shim is root-owned and not writable by the user the runtime runs as. The runtime is
#      the untrusted party; a shim it can rewrite is a shim it can replace.
#   3. It runs as non-root, with no capability to become root.
#   4. It mounts no service-account token of its own. The pod template governs that projection,
#      and the image must not smuggle in an identity of its own.

# ───────────────────────────── shim builder ─────────────────────────────────
# The shim's own build (tsdown.shim.config.ts) inlines every dependency so this image installs
# no node_modules for it. That separation is asserted at build time by the daemon package's
# assert-self-contained step and re-asserted here against the copied artifact.
FROM node:24-bookworm-slim AS shim-builder
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
# The workspace deps are built FIRST, then only the shim bundle. Running tsdown alone looked
# right and silently produced a bundle that left @agentconnect.md/protocol and /connection
# external — 167 KB instead of 288 KB — so the shim would have died at startup on a module the
# image has no node_modules to resolve. Building the daemon TARGET too would instead pull its
# whole chunk graph into a layer this image has no use for.
RUN pnpm --filter "@agentconnect.md/daemon^..." build \
  && pnpm --filter @agentconnect.md/daemon exec tsdown --config tsdown.shim.config.ts

# ─────────────────────────────── runtime ────────────────────────────────────
FROM node:24-bookworm-slim AS runtime-sandbox

# The ACP runtimes this image declares it provides. Pinned exactly: the published runtime table
# names these versions, and a floating tag would make the table a claim about the past.
ARG CLAUDE_ACP_VERSION=0.66.0
ARG CODEX_ACP_VERSION=1.1.14

# git and ca-certificates are load-bearing — the workspace surface runs git IN here over the
# shim's exec channel. openssh-client is for ssh remotes; tini is PID 1. Nothing else: every
# additional binary is one more thing half-trusted code can reach.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git openssh-client tini \
  && rm -rf /var/lib/apt/lists/*

# Installed globally so the shim resolves a real executable on PATH. `--cloud` deliberately
# refuses package-launcher (npx/uvx) entries: fetching a runtime at spawn time would mean the
# image pin says nothing about what actually runs, and would need registry egress from a
# sandbox that should have none.
RUN npm install --global --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
  "@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}" \
  && npm cache clean --force

# Root-owned and read-only: the runtime is the untrusted party in this image, and a shim it can
# modify is a shim it can replace with one that answers the daemon's requests however it likes.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/index.js /opt/agentconnect/shim/index.js
RUN chmod 0444 /opt/agentconnect/shim/index.js && chmod 0555 /opt/agentconnect/shim

# The declared runtime table, generated from THIS image's contents so it cannot drift from what
# is installed. Consumed by the daemon in --cloud mode (a ConfigMap projection may override the
# path); published as an image artifact rather than compiled into the daemon package, so the
# image pin and the daemon version stay independent.
COPY docker/runtime-sandbox/generate-runtime-table.mjs /opt/agentconnect/bin/generate-runtime-table.mjs
RUN node /opt/agentconnect/bin/generate-runtime-table.mjs /opt/agentconnect/runtime/cloud-runtimes.json \
  && chmod -R a-w /opt/agentconnect/runtime

# uid/gid are fixed rather than allocated, so a PersistentVolume written by one image version is
# still readable by the next.
RUN groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --home-dir /agent --shell /usr/sbin/nologin --create-home agent \
  && chown 10001:10001 /agent
ENV HOME=/agent \
  AC_SHIM_WORKSPACE_ROOT=/agent \
  npm_config_update_notifier=false \
  NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /agent
USER 10001:10001

# tini reaps the runtime's children and forwards SIGTERM, which is what makes a graceful drain
# possible. The shim is the only process this image starts: it dials the daemon out, and the
# runtime is spawned by it rather than by an entrypoint that would run before any binding exists.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agentconnect/shim/index.js"]
