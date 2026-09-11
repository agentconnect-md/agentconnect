# syntax=docker/dockerfile:1.7

ARG RUNTIME_SANDBOX_BASE=ghcr.io/agentconnect-md/runtime-sandbox:base-20260910.1@sha256:3da638f4707c4cb28522b3c82e3b5448c40a24d3b9723690a5cc62538dfc2296
ARG RUNTIME_SANDBOX_FULL_BASE=ghcr.io/agentconnect-md/runtime-sandbox-full:base-20260910.1@sha256:425a1558338bd2c68dc69da846ee88ca5e1bbf2d212a3bc1a65d75c4761e59c0

ARG AGENT_BROWSER_VERSION=0.37.1
ARG CLAUDE_ACP_VERSION=0.76.0
ARG CODEX_ACP_VERSION=1.11.0-agentconnect.1
ARG DEEPSEEK_HARNESS_ACP_VERSION=0.4.30

# Release builds install applications over stable system bases, then add daemon-versioned helpers.

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

# ────────────────────────────── payload digest ──────────────────────────────
# The payload's content digest, taken from the stage the images copy; build.yaml aliases an image whose digest matches.
FROM runtime-helpers AS runtime-payload-digest
RUN node /build/scripts/tree-digest.mjs /out > /payload-digest

# Exported alone as one small file: a non-root receiver cannot take a local export of the payload's 0555 directories.
FROM scratch AS runtime-payload-digest-export
COPY --from=runtime-payload-digest /payload-digest /

# Antigravity is the first, independently cached application layer in the full image.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS antigravity
ARG ANTIGRAVITY_VERSION=1.1.1
ARG ANTIGRAVITY_SHA256_AMD64=38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df
ARG TARGETARCH
RUN test "${TARGETARCH:-amd64}" = amd64 \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/antigravity
RUN curl --retry 5 -fsSL -o /tmp/antigravity.zip \
  "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_${ANTIGRAVITY_VERSION}-linux-x86_64.zip" \
  && printf '%s  /tmp/antigravity.zip\n' "$ANTIGRAVITY_SHA256_AMD64" | sha256sum -c - \
  && unzip -q /tmp/antigravity.zip -d /out/antigravity \
  && test -x /out/antigravity/agy_acp_server.par \
  && test -x /out/antigravity/localharness_external \
  && chmod -R a-w /out/antigravity \
  && rm /tmp/antigravity.zip

# Other native harness downloads are independent of Antigravity and agent-browser.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS full-native-runtimes
ARG OMP_VERSION=17.0.5
ARG OMP_SHA256_AMD64=319d08ab8e5fb80c73f734907d5f47aa8bbd4ea31f7a19bacf8611c5aba26c31
ARG DEVIN_VERSION=3000.6.14
ARG DEVIN_SHA256_AMD64=28cf64c1df9f58ccd063fb7e6fd6e9391073c585b733449371485e1ef8a3e6db
ARG TARGETARCH
RUN test "${TARGETARCH:-amd64}" = amd64 \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/bin
RUN curl --retry 5 -fsSL -o /tmp/omp \
  "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
  && printf '%s  /tmp/omp\n' "$OMP_SHA256_AMD64" | sha256sum -c - \
  && install -m 0555 /tmp/omp /out/bin/omp \
  && rm /tmp/omp
RUN curl --retry 5 -fsSL -o /tmp/devin.tar.gz \
  "https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-x86_64-unknown-linux.tar.gz" \
  && printf '%s  /tmp/devin.tar.gz\n' "$DEVIN_SHA256_AMD64" | sha256sum -c - \
  && tar -xzf /tmp/devin.tar.gz -C /tmp bin/devin \
  && install -m 0555 /tmp/bin/devin /out/bin/devin \
  && rm -rf /tmp/devin.tar.gz /tmp/bin

FROM ${RUNTIME_SANDBOX_FULL_BASE} AS runtime-sandbox-full-apps
USER root
# Antigravity resolves its local harness relative to the ACP executable.
COPY --link --from=antigravity --chown=0:0 /out/antigravity/ /opt/agentconnect/runtimes/antigravity/
RUN printf '%s\n' '#!/bin/sh' \
  'exec /opt/agentconnect/runtimes/antigravity/agy_acp_server.par "$@"' > /usr/local/bin/antigravity-acp \
  && chmod 0555 /usr/local/bin/antigravity-acp

ARG AGENT_BROWSER_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-agent-browser.sh,target=/tmp/install-agent-browser.sh \
  HOME=/root sh /tmp/install-agent-browser.sh

ARG CLAUDE_ACP_VERSION
ARG CODEX_ACP_VERSION
ARG DEEPSEEK_HARNESS_ACP_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-core-harnesses.sh,target=/tmp/install-core-harnesses.sh \
  --mount=type=bind,source=docker/runtime-sandbox/bake-dsh-preset.mjs,target=/tmp/bake-dsh-preset.mjs \
  HOME=/root sh /tmp/install-core-harnesses.sh

ARG CLINE_VERSION=3.0.61
ARG PI_ACP_VERSION=0.0.33
ARG PI_VERSION=0.80.6
ARG OPENCODE_VERSION=1.17.18
ARG QWEN_CODE_VERSION=0.23.1
ARG COPILOT_VERSION=1.0.83
ARG GROK_VERSION=1.0.24
ARG QODER_VERSION=1.1.14
ARG QODER_CN_VERSION=1.1.2
# pi-acp delegates to the separately installed pi CLI; all launches use local executables.
RUN export HOME=/root \
  && npm install --global --no-fund --no-audit \
    "cline@${CLINE_VERSION}" \
    "pi-acp@${PI_ACP_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
    "@github/copilot@${COPILOT_VERSION}" \
    "@xai-official/grok@${GROK_VERSION}" \
    "@qoder-ai/qodercli@${QODER_VERSION}" "@qodercn-ai/qoderclicn@${QODER_CN_VERSION}" \
  && npm cache clean --force
COPY --from=full-native-runtimes --chown=0:0 /out/bin/ /usr/local/bin/
# Bake the runtime table after all applications are installed, using a disposable non-root HOME.
COPY docker/runtime-sandbox/generate-runtime-table.mjs /opt/agentconnect/bin/generate-runtime-table.mjs
COPY docker/runtime-sandbox/installed-runtimes-full.json /opt/agentconnect/runtime/installed-runtimes.json
USER 10001:10001
RUN mkdir -p /tmp/ac-probe/home /tmp/ac-probe/cwd \
  && HOME=/tmp/ac-probe/home AC_PROBE_CWD=/tmp/ac-probe/cwd \
    node /opt/agentconnect/bin/generate-runtime-table.mjs /tmp/ac-probe/k8s-runtimes.json
USER root
RUN mv /tmp/ac-probe/k8s-runtimes.json /opt/agentconnect/runtime/k8s-runtimes.json \
  && rm -rf /tmp/ac-probe \
  && chown -R root:root /opt/agentconnect/runtime \
  && chmod -R a-w /opt/agentconnect/runtime
USER 10001:10001

FROM ${RUNTIME_SANDBOX_BASE} AS runtime-sandbox-apps
USER root
ARG AGENT_BROWSER_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-agent-browser.sh,target=/tmp/install-agent-browser.sh \
  HOME=/root sh /tmp/install-agent-browser.sh

ARG CLAUDE_ACP_VERSION
ARG CODEX_ACP_VERSION
ARG DEEPSEEK_HARNESS_ACP_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-core-harnesses.sh,target=/tmp/install-core-harnesses.sh \
  --mount=type=bind,source=docker/runtime-sandbox/bake-dsh-preset.mjs,target=/tmp/bake-dsh-preset.mjs \
  HOME=/root sh /tmp/install-core-harnesses.sh

# Bake the runtime table after all applications are installed, using a disposable non-root HOME.
COPY docker/runtime-sandbox/generate-runtime-table.mjs /opt/agentconnect/bin/generate-runtime-table.mjs
COPY docker/runtime-sandbox/installed-runtimes.json /opt/agentconnect/runtime/installed-runtimes.json
USER 10001:10001
RUN mkdir -p /tmp/ac-probe/home /tmp/ac-probe/cwd \
  && HOME=/tmp/ac-probe/home AC_PROBE_CWD=/tmp/ac-probe/cwd \
    node /opt/agentconnect/bin/generate-runtime-table.mjs /tmp/ac-probe/k8s-runtimes.json
USER root
RUN mv /tmp/ac-probe/k8s-runtimes.json /opt/agentconnect/runtime/k8s-runtimes.json \
  && rm -rf /tmp/ac-probe \
  && chown -R root:root /opt/agentconnect/runtime \
  && chmod -R a-w /opt/agentconnect/runtime
USER 10001:10001

# ────────────────────────── runtime table check ─────────────────────────────
# Re-probe the application table independently of the shim so shim-only changes reuse this check.
FROM runtime-sandbox-full-apps AS runtime-sandbox-full-table-check
COPY scripts/runtime-table-diff.mjs scripts/verify-runtime-table.mjs /tmp/ac-check/
COPY docker/runtime-sandbox/installed-runtimes-full.json /tmp/ac-check/installed-runtimes.json
# Use the same disposable non-root environment that generated the application table.
RUN mkdir -p /tmp/ac-probe/home /tmp/ac-probe/cwd \
  && HOME=/tmp/ac-probe/home AC_PROBE_CWD=/tmp/ac-probe/cwd \
    node /tmp/ac-check/verify-runtime-table.mjs runtime-sandbox-full /tmp/ac-check/installed-runtimes.json \
  && touch /tmp/ac-table-check.ok

FROM runtime-sandbox-apps AS runtime-sandbox-table-check
COPY scripts/runtime-table-diff.mjs scripts/verify-runtime-table.mjs /tmp/ac-check/
COPY docker/runtime-sandbox/installed-runtimes.json /tmp/ac-check/installed-runtimes.json
RUN mkdir -p /tmp/ac-probe/home /tmp/ac-probe/cwd \
  && HOME=/tmp/ac-probe/home AC_PROBE_CWD=/tmp/ac-probe/cwd \
    node /tmp/ac-check/verify-runtime-table.mjs runtime-sandbox /tmp/ac-check/installed-runtimes.json \
  && touch /tmp/ac-table-check.ok

# ───────────────────────────── release images ───────────────────────────────
# Add the independently compiled shim after all application layers.
FROM runtime-sandbox-full-apps AS runtime-sandbox-full
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/

FROM runtime-sandbox-apps AS runtime-sandbox
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/

# ───────────────────────────── shim smoke test ──────────────────────────────
# The acceptance criterion, run inside the build: the image's own entrypoint started the way the pod starts it, the
# daemon side (ShimDialer and ShimSession from the shim-builder's workspace, bind-mounted, never copied into a layer)
# dialling it over loopback, the real ACP runtime spawned through the shim, then `initialize` and one `session/new`.
# Nothing here is published; the marker feeds the verify stage. Only the token's directory needs root, as the pod
# projects it, so the image's fixed uid is restored before the smoke runs.
FROM runtime-sandbox-full AS runtime-sandbox-full-smoke
USER root
RUN install -d -o 10001 -g 10001 /var/run/ac-identity
USER 10001:10001
# Started under a subreaper as PID 1 would be; the tooling's HOME and TMPDIR are disposable, the runtime's are the pod's.
RUN --mount=type=bind,from=shim-builder,source=/build,target=/build \
  mkdir -p /tmp/ac-smoke/home \
  && head -c 32 /dev/urandom | base64 > /var/run/ac-identity/token \
  && { TINI_SUBREAPER=1 /usr/bin/tini -- node /opt/agentconnect/shim/index.js & shim=$!; } \
  && HOME=/tmp/ac-smoke/home TMPDIR=/tmp/ac-smoke node /build/packages/daemon/node_modules/tsx/dist/cli.mjs \
    /build/packages/daemon/scripts/smoke-runtime-image.mts --connect "127.0.0.1:${AC_SHIM_PORT}"; \
  status=$?; kill "$shim" 2>/dev/null; wait "$shim" 2>/dev/null; [ "$status" -eq 0 ] && touch /tmp/ac-smoke.ok

FROM runtime-sandbox AS runtime-sandbox-smoke
USER root
RUN install -d -o 10001 -g 10001 /var/run/ac-identity
USER 10001:10001
RUN --mount=type=bind,from=shim-builder,source=/build,target=/build \
  mkdir -p /tmp/ac-smoke/home \
  && head -c 32 /dev/urandom | base64 > /var/run/ac-identity/token \
  && { TINI_SUBREAPER=1 /usr/bin/tini -- node /opt/agentconnect/shim/index.js & shim=$!; } \
  && HOME=/tmp/ac-smoke/home TMPDIR=/tmp/ac-smoke node /build/packages/daemon/node_modules/tsx/dist/cli.mjs \
    /build/packages/daemon/scripts/smoke-runtime-image.mts --connect "127.0.0.1:${AC_SHIM_PORT}"; \
  status=$?; kill "$shim" 2>/dev/null; wait "$shim" 2>/dev/null; [ "$status" -eq 0 ] && touch /tmp/ac-smoke.ok

# ─────────────────────────── in-image verification ──────────────────────────
# Verify the table, real shim session and filesystem as the final user; the host check resolves inherited image config.
FROM runtime-sandbox-full AS runtime-sandbox-full-verify
COPY --from=runtime-sandbox-full-table-check /tmp/ac-table-check.ok /tmp/ac-check/table.ok
COPY --from=runtime-sandbox-full-smoke /tmp/ac-smoke.ok /tmp/ac-check/smoke.ok
COPY docker/runtime-sandbox/verify-image.mjs /tmp/ac-check/verify-image.mjs
RUN node /tmp/ac-check/verify-image.mjs runtime-sandbox-full

FROM runtime-sandbox AS runtime-sandbox-verify
COPY --from=runtime-sandbox-table-check /tmp/ac-table-check.ok /tmp/ac-check/table.ok
COPY --from=runtime-sandbox-smoke /tmp/ac-smoke.ok /tmp/ac-check/smoke.ok
COPY docker/runtime-sandbox/verify-image.mjs /tmp/ac-check/verify-image.mjs
RUN node /tmp/ac-check/verify-image.mjs runtime-sandbox

# Keep the pool image as the default build target.
FROM runtime-sandbox
