# syntax=docker/dockerfile:1.7

#
# The RUNTIME SANDBOX image — what an agent's ACP runtime executes inside.
#
# Deliberately a different image from docker/Dockerfile's service targets. Those run the
# published daemon and control-plane packages; this one runs half-trusted agent code, so it
# carries the opposite bias: the shim, plus the baseline build toolchain a coding agent needs, and
# nothing else.
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
  && pnpm --filter @agentconnect.md/daemon run build:shim

# ───────────────────────────── gh CLI fetch ─────────────────────────────────
# The real GitHub CLI, downloaded and checksum-verified in a stage that ships nothing of itself: the runtime
# layer receives only the verified binary and never sees the curl this needs, so "the shim and nothing the shim
# does not need" still holds. Pinned by version AND sha256 — an unpinned download would make the contents of an
# image that runs half-trusted code a function of whatever a mirror served on build day.
FROM node:24-bookworm-slim AS gh-cli
ARG GH_CLI_VERSION=2.97.0
ARG GH_CLI_SHA256_AMD64=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112
ARG GH_CLI_SHA256_ARM64=73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5
ARG TARGETARCH
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
  amd64) sha256="$GH_CLI_SHA256_AMD64" ;; \
  arm64) sha256="$GH_CLI_SHA256_ARM64" ;; \
  *) echo "no pinned gh checksum for TARGETARCH=$arch" >&2; exit 1 ;; \
  esac; \
  tarball="gh_${GH_CLI_VERSION}_linux_${arch}.tar.gz"; \
  curl -fsSL -o "/tmp/${tarball}" "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${tarball}"; \
  printf '%s  /tmp/%s\n' "$sha256" "$tarball" | sha256sum -c -; \
  tar -xzf "/tmp/${tarball}" -C /tmp; \
  install -D -m 0555 "/tmp/gh_${GH_CLI_VERSION}_linux_${arch}/bin/gh" /out/gh; \
  /out/gh --version

# ─────────────────────────────── runtime ────────────────────────────────────
FROM node:24-bookworm-slim AS runtime-sandbox

# Exact pins keep the published runtime table truthful.
ARG CLAUDE_ACP_VERSION=0.70.0
ARG CODEX_ACP_VERSION=1.6.2-agentconnect.1
ARG DEEPSEEK_HARNESS_ACP_VERSION=0.4.16

# git and ca-certificates are load-bearing — the workspace surface runs git IN here over the
# shim's exec channel. openssh-client is for ssh remotes; tini is PID 1.
# curl, python3 (+venv/pip) and build-essential are the baseline toolchain an agent needs to build and
# run the workspace it was given; without them a routine `pip install` or native-module build just fails.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates git openssh-client tini \
    build-essential curl pkg-config python3 python3-dev python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
# `python` as well as `python3` — plenty of tooling still spawns the unsuffixed name.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Global installs give `--k8s` fixed PATH binaries without registry egress at spawn time.
RUN npm install --global --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
  "@agentconnect.md/codex-acp@${CODEX_ACP_VERSION}" \
  "@openma/deepseek-harness-acp@${DEEPSEEK_HARNESS_ACP_VERSION}" \
  && npm cache clean --force

# Root-owned and read-only: the runtime is the untrusted party in this image, and a shim it can
# modify is a shim it can replace with one that answers the daemon's requests however it likes.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/index.js /opt/agentconnect/shim/index.js
# The credential helper is its own bundle with a disjoint graph, so it is its own single file. Git
# spawns it once per operation; loading the channel's WebSocket client for that would be waste.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/git-credential.js /opt/agentconnect/shim/git-credential.js
# The gh wrapper's token fetch, a third disjoint bundle for the same reason: the wrapper spawns it once per `gh`.
# Path must match SANDBOX_GH_TOKEN_ENTRY in packages/daemon/src/shim/sandbox-paths.ts.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/gh-token.js /opt/agentconnect/shim/gh-token.js
# The AgentConnect tool server, a fourth disjoint bundle: the agent's harness spawns it once per session from the
# spec the daemon sends, and it reaches the daemon over the `mcp` tunnel rather than this image's filesystem.
# Path must match SANDBOX_MCP_BRIDGE_ENTRY in packages/daemon/src/shim/sandbox-paths.ts — the daemon puts this path
# in the spec, so a rename here is a runtime that retries a missing module until it gives up.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/mcp-bridge.js /opt/agentconnect/shim/mcp-bridge.js
# The merge-when-ready watcher, a fifth disjoint bundle: the shim spawns one per armed pull request, so the
# armed set lives and dies with this pod. Path must match SANDBOX_AUTO_MERGE_ENTRY in
# packages/daemon/src/shim/sandbox-paths.ts — the handler reports its absence as an unsupported image.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/auto-merge.js /opt/agentconnect/shim/auto-merge.js
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/skills /opt/agentconnect/shim/skills
RUN chmod 0444 /opt/agentconnect/shim/index.js /opt/agentconnect/shim/git-credential.js \
  /opt/agentconnect/shim/gh-token.js /opt/agentconnect/shim/mcp-bridge.js /opt/agentconnect/shim/auto-merge.js \
  /opt/agentconnect/shim/skills/dist/cli.js /opt/agentconnect/shim/skills/workspace-mutation.js \
  /opt/agentconnect/shim/skills/package.json \
  && chmod 0555 /opt/agentconnect/shim

# The executable git runs as its credential helper. A wrapper because git needs something
# executable and the bundle is a .js, and root-owned/unwritable for the same reason the shim is: one
# the runtime could rewrite is one it could replace with a helper that asks the daemon for
# credentials in its name. Args are `<agentId> <action>`, the action appended by git. Path must match
# SANDBOX_GIT_CREDENTIAL_HELPER in packages/daemon/src/shim/sandbox-paths.ts.
RUN mkdir -p /opt/agentconnect/bin \
  && printf '#!/bin/sh\n# agentconnect git credential helper — see src/shim/git-credential.ts.\nexec node /opt/agentconnect/shim/git-credential.js "$@"\n' \
    > /opt/agentconnect/bin/git-credential \
  && chown -R root:root /opt/agentconnect/bin \
  && chmod 0555 /opt/agentconnect/bin /opt/agentconnect/bin/git-credential

# The real gh the wrapper execs, verified in the gh-cli stage. gh has no credential-helper hook — it reads a
# STATIC GH_TOKEN fixed at spawn — so a pod agent gets per-repo, per-invocation tokens only through the wrapper.
COPY --from=gh-cli --chown=0:0 /out/gh /usr/local/bin/gh

# The ONLY directory this image prepends to the agent runtime's PATH (src/shim/acp-runner.ts), holding the gh
# wrapper and nothing else: /opt/agentconnect/shim and /opt/agentconnect/bin stay off PATH so the credential
# helper and the runtime-table generator never become commands an agent can run by name. Generated from the same
# renderGhWrapper the daemon's own wrapper comes from, and root-owned/unwritable for the reason the shim is —
# one the runtime could rewrite is one it could replace with a wrapper that asks the daemon in its name.
# Path must match SANDBOX_GH_WRAPPER_DIR in packages/daemon/src/shim/sandbox-paths.ts.
COPY --from=shim-builder --chown=0:0 /build/packages/daemon/dist/shim/gh /opt/agentconnect/pathbin/gh
RUN chown -R root:root /opt/agentconnect/pathbin \
  && chmod 0555 /opt/agentconnect/pathbin /opt/agentconnect/pathbin/gh

# uid/gid are fixed rather than allocated, so a PersistentVolume written by one image version is
# still readable by the next.
RUN groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --home-dir /agent --shell /usr/sbin/nologin --create-home agent \
  && chown 10001:10001 /agent

# Where the shim serves the daemon's unix sockets (src/shim/tunnel.ts SANDBOX_TUNNEL_PATHS).
# Created HERE because /run is root-owned and the shim runs as 10001: without an owned directory
# it cannot bind, and the failure would look like a credential problem rather than a permission
# one. Not on the workspace volume on purpose — a socket is this pod's, not the workspace's.
RUN mkdir -p /run/agentconnect \
  && chown 10001:10001 /run/agentconnect \
  && chmod 0700 /run/agentconnect

# The declared runtime table, generated by ASKING each runtime in THIS image so it cannot drift
# from what is installed. Deliberately after the workspace root exists: the generator opens a real
# session to capture the mode list, and a session needs a cwd — so a table produced any earlier
# would describe an image that does not exist yet.
#
# Published as an image artifact rather than compiled into the daemon package: the daemon consumes
# it by PROBING a sandbox for it (the shim's probe channel), and compiling it in would tie
# the image pin to the daemon version, which is the coupling this seam exists to avoid.
COPY docker/runtime-sandbox/generate-runtime-table.mjs /opt/agentconnect/bin/generate-runtime-table.mjs
# Probed AS THE RUNTIME USER, in a throwaway HOME and cwd that are deleted afterwards. Two reasons,
# both learned from getting it wrong: a table probed as root describes an identity production never
# uses, and the probe leaves state behind — a root-run probe left root-owned .claude/.codex in
# /agent, and codex then failed to start for the very user that owns the workspace.
USER 10001:10001
RUN mkdir -p /tmp/ac-probe/home /tmp/ac-probe/cwd \
  && HOME=/tmp/ac-probe/home AC_PROBE_CWD=/tmp/ac-probe/cwd \
    node /opt/agentconnect/bin/generate-runtime-table.mjs /tmp/ac-probe/k8s-runtimes.json
USER root
RUN mkdir -p /opt/agentconnect/runtime \
  && mv /tmp/ac-probe/k8s-runtimes.json /opt/agentconnect/runtime/k8s-runtimes.json \
  && rm -rf /tmp/ac-probe \
  && chown -R root:root /opt/agentconnect/runtime \
  && chmod -R a-w /opt/agentconnect/runtime
# Provider config accepted from the pod env (interim until the managed egress proxy): the shim
# maps AC_CLAUDE_BASE_URL/AC_CLAUDE_API_KEY → ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY,
# AC_CODEX_BASE_URL/AC_CODEX_API_KEY → OPENAI_BASE_URL/OPENAI_API_KEY, and
# AC_DEEPSEEK_BASE_URL/AC_DEEPSEEK_API_KEY → DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY onto the matching
# runtime only, and a value the daemon already sent for that runtime wins (src/shim/acp-runner.ts).
ENV HOME=/agent \
  AC_SHIM_WORKSPACE_ROOT=/agent \
  AC_SHIM_PORT=8085 \
  npm_config_update_notifier=false \
  NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 8085
WORKDIR /agent
USER 10001:10001

# tini reaps the runtime's children and forwards SIGTERM, which is what makes a graceful drain
# possible. The shim is the only process this image starts: it listens for its daemon, then spawns
# the runtime only after the channel is bound.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agentconnect/shim/index.js"]
