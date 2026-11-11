# syntax=docker/dockerfile:1.7

ARG RUNTIME_SANDBOX_BASE=ghcr.io/agentconnect-md/runtime-sandbox:base-20261029-233713@sha256:c6aab2632b8fa5c8dba84b891b05a21d5bd810b3d42b0333983b887dbb6055c9
ARG RUNTIME_SANDBOX_FULL_BASE=ghcr.io/agentconnect-md/runtime-sandbox-full:base-20261029-233713@sha256:15374558d1ec9e99d752e62eeac89008e93d03a3a9b00009ccb05eea3cae2ec7

ARG AGENT_BROWSER_VERSION=0.42.0
ARG CLAUDE_ACP_VERSION=0.106.0
ARG CODEX_ACP_VERSION=2.6.0-agentconnect.5
ARG DEEPSEEK_HARNESS_ACP_VERSION=0.4.41
ARG OPENCODE_VERSION=2.2.7

# Release builds install applications over stable system bases, then add daemon-versioned helpers.

# ───────────────────────────── shim builder ─────────────────────────────────
# The shim build inlines its dependencies so runtime images need no daemon node_modules.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS shim-builder
WORKDIR /build
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH
RUN npm install --global corepack@0.36.0 && corepack enable
RUN printf 'fetch-retries=5\nfetch-retry-maxtimeout=600000\nfetch-retry-mintimeout=20000\nfetch-timeout=600000\nnetwork-concurrency=8\n' >> /root/.npmrc

# .pnpmfile.mjs is checksummed INTO the lockfile, so a frozen install without it is refused.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .pnpmfile.mjs tsconfig.base.json ./
COPY patches/ patches/
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
RUN pnpm --filter "@agentconnect.md/daemon^..." build:package \
  && pnpm --filter @agentconnect.md/daemon run build:shim

# Set immutable modes before copying the small payload into either final image.
FROM shim-builder AS runtime-helpers
RUN mkdir -p /out/shim /out/pathbin \
  && cp /build/packages/daemon/dist/shim/*.js /out/shim/ \
  && cp -R /build/packages/daemon/dist/shim/skills /out/shim/skills \
  && cp /build/packages/daemon/dist/shim/agentconnect-secrets /out/pathbin/agentconnect-secrets \
  && chmod 0444 /out/shim/*.js /out/shim/skills/dist/cli.js \
    /out/shim/skills/workspace-mutation.js /out/shim/skills/package.json \
  && chmod 0555 /out/shim /out/pathbin /out/pathbin/agentconnect-secrets

# ────────────────────────────── payload digest ──────────────────────────────
# The payload's content digest, taken from the stage the images copy; build.yaml aliases an image whose digest matches.
FROM runtime-helpers AS runtime-payload-digest
RUN node /build/scripts/tree-digest.mjs /out > /payload-digest

# Exported alone as one small file: a non-root receiver cannot take a local export of the payload's 0555 directories.
FROM scratch AS runtime-payload-digest-export
COPY --from=runtime-payload-digest /payload-digest /

# Both runtime images share the pinned CLI and its system extension, independent of each session's empty Azure state.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS azure-cli
ARG AZURE_CLI_VERSION=2.92.0
ARG AZURE_CLI_SHA256_AMD64=ad0285eaf900cd5e91218e9ad6ac28ce2749d3f8d3fe17f397d7fbf4ca5a5457
ARG AZURE_CLI_SHA256_ARM64=670627cb5338b95dd77d3bfc8f548b11fe125a723ebff647e245a27e241ddcb9
ARG AZURE_DEVOPS_VERSION=1.0.10
ARG AZURE_DEVOPS_SHA256=cb38021f76cf93905f759c9d1b4b441bdeecfc98d4141ce26dd7b299af1aa56e
ARG TARGETARCH
RUN set -eu; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in \
  amd64) sha256="$AZURE_CLI_SHA256_AMD64" ;; \
  arm64) sha256="$AZURE_CLI_SHA256_ARM64" ;; \
  *) echo "no pinned Azure CLI checksum for TARGETARCH=$arch" >&2; exit 1 ;; \
  esac; \
  apt-get update; \
  apt-get install --no-install-recommends -y ca-certificates curl; \
  curl --retry 5 -fsSL -o /tmp/azure-cli.deb \
    "https://packages.microsoft.com/repos/azure-cli/pool/main/a/azure-cli/azure-cli_${AZURE_CLI_VERSION}-1~bookworm_${arch}.deb"; \
  printf '%s  /tmp/azure-cli.deb\n' "$sha256" | sha256sum -c -; \
  apt-get install --no-install-recommends -y /tmp/azure-cli.deb; \
  wheel="azure_devops-${AZURE_DEVOPS_VERSION}-py2.py3-none-any.whl"; \
  curl --retry 5 -fsSL -o "/tmp/${wheel}" "https://azcliprod.blob.core.windows.net/cli-extensions/${wheel}"; \
  printf '%s  /tmp/%s\n' "$AZURE_DEVOPS_SHA256" "$wheel" | sha256sum -c -; \
  AZURE_CORE_COLLECT_TELEMETRY=false az extension add --system --source "/tmp/${wheel}" --yes; \
  chmod -R a-w /opt/az /usr/bin/az; \
  rm -rf /var/lib/apt/lists/* /tmp/azure-cli.deb "/tmp/${wheel}"

# Antigravity is the first, independently cached application layer in the full image.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS antigravity
ARG ANTIGRAVITY_VERSION=1.4.5
ARG ANTIGRAVITY_SHA256_AMD64=923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b
ARG TARGETARCH
RUN test "${TARGETARCH:-amd64}" = amd64 \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/antigravity
RUN curl --retry 5 -fsSL -o /tmp/antigravity.zip \
  "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${ANTIGRAVITY_VERSION}-linux-x86_64.zip" \
  && printf '%s  /tmp/antigravity.zip\n' "$ANTIGRAVITY_SHA256_AMD64" | sha256sum -c - \
  && unzip -q /tmp/antigravity.zip -d /out/antigravity \
  && test -x /out/antigravity/agy_acp_server.par \
  && test -x /out/antigravity/localharness_external \
  && chmod -R a-w /out/antigravity \
  && rm /tmp/antigravity.zip

# Build Muse's adapter against Bookworm: upstream Linux binaries require glibc 2.39.
FROM rust:1.99.0-slim-bookworm@sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa AS muse-acp
ARG MUSE_ACP_VERSION=0.21.0
ARG MUSE_ACP_SOURCE_SHA256=36e984ff3808783cbaacfd76b24fe1b68e8ea6e6bad16c5888a11a10dc5b841c
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --retry 5 -fsSL -o /tmp/muse-acp.tar.gz \
  "https://codeload.github.com/BrokkAi/muse-acp/tar.gz/refs/tags/v${MUSE_ACP_VERSION}" \
  && printf '%s  /tmp/muse-acp.tar.gz\n' "$MUSE_ACP_SOURCE_SHA256" | sha256sum -c - \
  && tar -xzf /tmp/muse-acp.tar.gz --strip-components=1 \
  && CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 cargo build --release --locked --jobs 1 \
  && install -D -m 0555 target/release/muse-acp /out/bin/muse-acp \
  && mkdir -p /out/licenses/muse-acp \
  && cp LICENSE NOTICE /out/licenses/muse-acp/

# Other native harness downloads are independent of Antigravity and agent-browser.
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS full-native-runtimes
ARG OMP_VERSION=18.18.6
ARG OMP_SHA256_AMD64=a8059b95de5eaba0b3fb6f7182842d661feae29cb2931cdbeba2986db4751ecb
ARG DEVIN_VERSION=3000.12.43
ARG DEVIN_SHA256_AMD64=6a19997b5fc2d6ba1a8c341d4e2b12f1b78cad5d415ee9c0ca413a8d52a99562
ARG MUSE_VERSION=1.4.15-R8339.1
ARG MUSE_SHA256_AMD64=abe0a72878c62b570c6eed6c17c5fc3c520a990ecf040511741c00092312a3d5
ARG KILO_VERSION=7.8.27
ARG KILO_SHA256_AMD64=4c08aa46dd87453a329f48b0f00d34d0fa7b8f0ac910fe8937814d4e8582de08
ARG GOOSE_VERSION=1.58.1
ARG GOOSE_SHA256_AMD64=20a71c86b119fe66216b40d76de0bfd2dc053feab8b81b4804ecf066df6874f2
ARG TARGETARCH
RUN test "${TARGETARCH:-amd64}" = amd64 \
  && apt-get update \
  && apt-get install --no-install-recommends -y bzip2 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/bin /out/kilo
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
RUN curl --retry 5 -fsSL -o /tmp/muse \
  "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${MUSE_VERSION}&file=muse-x86-linux" \
  && printf '%s  /tmp/muse\n' "$MUSE_SHA256_AMD64" | sha256sum -c - \
  && install -m 0555 /tmp/muse /out/bin/muse \
  && rm /tmp/muse
# Kilo resolves its tree-sitter grammars and console assets beside its executable, so it keeps its own directory.
RUN curl --retry 5 -fsSL -o /tmp/kilo.tar.gz \
  "https://github.com/Kilo-Org/kilocode/releases/download/v${KILO_VERSION}/kilo-linux-x64.tar.gz" \
  && printf '%s  /tmp/kilo.tar.gz\n' "$KILO_SHA256_AMD64" | sha256sum -c - \
  && tar -xzf /tmp/kilo.tar.gz -C /out/kilo \
  && test -x /out/kilo/kilo \
  && chmod -R a-w /out/kilo \
  && rm /tmp/kilo.tar.gz
RUN curl --retry 5 -fsSL -o /tmp/goose.tar.bz2 \
  "https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-x86_64-unknown-linux-gnu.tar.bz2" \
  && printf '%s  /tmp/goose.tar.bz2\n' "$GOOSE_SHA256_AMD64" | sha256sum -c - \
  && tar -xjf /tmp/goose.tar.bz2 -C /tmp ./goose \
  && install -m 0555 /tmp/goose /out/bin/goose \
  && rm /tmp/goose /tmp/goose.tar.bz2

FROM ${RUNTIME_SANDBOX_FULL_BASE} AS runtime-sandbox-full-apps
USER root
COPY --link --from=azure-cli --chown=0:0 /opt/az/ /opt/az/
COPY --from=azure-cli --chown=0:0 /usr/bin/az /usr/bin/az
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
ARG OPENCODE_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-core-harnesses.sh,target=/tmp/install-core-harnesses.sh \
  --mount=type=bind,source=docker/runtime-sandbox/bake-dsh-preset.mjs,target=/tmp/bake-dsh-preset.mjs \
  HOME=/root sh /tmp/install-core-harnesses.sh

ARG CLINE_VERSION=3.0.74
ARG PI_ACP_VERSION=0.0.34
ARG PI_VERSION=1.5.2
ARG QWEN_CODE_VERSION=0.27.1
ARG COPILOT_VERSION=1.0.108
ARG GROK_VERSION=1.0.77
ARG QODER_VERSION=1.1.86
ARG QODER_CN_VERSION=1.1.86
# pi-acp delegates to the separately installed pi CLI; all launches use local executables.
RUN export HOME=/root \
  && npm install --global --no-fund --no-audit \
    "cline@${CLINE_VERSION}" \
    "pi-acp@${PI_ACP_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "@qwen-code/qwen-code@${QWEN_CODE_VERSION}" \
    "@github/copilot@${COPILOT_VERSION}" \
    "@xai-official/grok@${GROK_VERSION}" \
    "@qoder-ai/qodercli@${QODER_VERSION}" "@qodercn-ai/qoderclicn@${QODER_CN_VERSION}" \
  && npm cache clean --force
COPY --from=full-native-runtimes --chown=0:0 /out/bin/ /usr/local/bin/
COPY --link --from=full-native-runtimes --chown=0:0 /out/kilo/ /opt/agentconnect/runtimes/kilo/
RUN printf '%s\n' '#!/bin/sh' 'exec /opt/agentconnect/runtimes/kilo/kilo "$@"' > /usr/local/bin/kilo \
  && chmod 0555 /usr/local/bin/kilo
COPY --from=muse-acp --chown=0:0 /out/bin/muse-acp /usr/local/bin/muse-acp
COPY --from=muse-acp --chown=0:0 /out/licenses/ /usr/local/share/licenses/
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
COPY --link --from=azure-cli --chown=0:0 /opt/az/ /opt/az/
COPY --from=azure-cli --chown=0:0 /usr/bin/az /usr/bin/az
ARG AGENT_BROWSER_VERSION
RUN --mount=type=bind,source=docker/runtime-sandbox/install-agent-browser.sh,target=/tmp/install-agent-browser.sh \
  HOME=/root sh /tmp/install-agent-browser.sh

ARG CLAUDE_ACP_VERSION
ARG CODEX_ACP_VERSION
ARG DEEPSEEK_HARNESS_ACP_VERSION
ARG OPENCODE_VERSION
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
COPY --link --chown=0:0 --chmod=0444 docker/runtime-sandbox/agentconnect-path.sh /etc/profile.d/agentconnect-path.sh

FROM runtime-sandbox-apps AS runtime-sandbox
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/
COPY --link --chown=0:0 --chmod=0444 docker/runtime-sandbox/agentconnect-path.sh /etc/profile.d/agentconnect-path.sh

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
COPY docker/runtime-sandbox/verify-image.mjs docker/runtime-sandbox/source-cache-git.mjs /tmp/ac-check/
RUN node /tmp/ac-check/verify-image.mjs runtime-sandbox-full

FROM runtime-sandbox AS runtime-sandbox-verify
COPY --from=runtime-sandbox-table-check /tmp/ac-table-check.ok /tmp/ac-check/table.ok
COPY --from=runtime-sandbox-smoke /tmp/ac-smoke.ok /tmp/ac-check/smoke.ok
COPY docker/runtime-sandbox/verify-image.mjs docker/runtime-sandbox/source-cache-git.mjs /tmp/ac-check/
RUN node /tmp/ac-check/verify-image.mjs runtime-sandbox

# Keep the pool image as the default build target.
FROM runtime-sandbox
