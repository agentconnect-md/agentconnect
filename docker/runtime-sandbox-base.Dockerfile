# syntax=docker/dockerfile:1.7

# Build and publish these dependency images manually; release builds use pinned digests.
# ───────────────────────────── gh CLI fetch ─────────────────────────────────
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS gh-cli
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ARG GH_CLI_VERSION=2.97.0
ARG GH_CLI_SHA256_AMD64=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112
ARG GH_CLI_SHA256_ARM64=73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5
ARG TARGETARCH
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

# ─────────────────────────── Chrome for Testing ─────────────────────────────
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS chrome
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
ARG CHROME_VERSION=152.0.7977.75
ARG CHROME_SHA256_AMD64=a16d36890636bd72251133b27f05825f7f9269c2425b3408fa3a76e10dccd8f1
ARG TARGETARCH
RUN set -eu; \
  arch="${TARGETARCH:-amd64}"; \
  if [ "$arch" != amd64 ]; then echo "Chrome for Testing publishes no linux build for TARGETARCH=$arch" >&2; exit 1; fi; \
  curl -fsSL -o /tmp/chrome.zip \
    "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"; \
  printf '%s  /tmp/chrome.zip\n' "$CHROME_SHA256_AMD64" | sha256sum -c -; \
  unzip -q /tmp/chrome.zip -d /tmp/cft; \
  mv /tmp/cft/chrome-linux64 /out; \
  test -x /out/chrome; \
  chmod -R a-w /out

# Standalone runtimes for the full image; their downloads never enter the pool image.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS full-native-runtimes
ARG OMP_VERSION=17.0.5
ARG OMP_SHA256_AMD64=319d08ab8e5fb80c73f734907d5f47aa8bbd4ea31f7a19bacf8611c5aba26c31
ARG ANTIGRAVITY_VERSION=1.1.1
ARG ANTIGRAVITY_SHA256_AMD64=38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df
ARG DEVIN_VERSION=3000.6.14
ARG DEVIN_SHA256_AMD64=28cf64c1df9f58ccd063fb7e6fd6e9391073c585b733449371485e1ef8a3e6db
ARG TARGETARCH
RUN test "${TARGETARCH:-amd64}" = amd64 \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /out/bin /out/antigravity
RUN curl --retry 5 -fsSL -o /tmp/omp \
  "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
  && printf '%s  /tmp/omp\n' "$OMP_SHA256_AMD64" | sha256sum -c - \
  && install -m 0555 /tmp/omp /out/bin/omp \
  && rm /tmp/omp
RUN curl --retry 5 -fsSL -o /tmp/antigravity.zip \
  "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_${ANTIGRAVITY_VERSION}-linux-x86_64.zip" \
  && printf '%s  /tmp/antigravity.zip\n' "$ANTIGRAVITY_SHA256_AMD64" | sha256sum -c - \
  && unzip -q /tmp/antigravity.zip -d /out/antigravity \
  && test -x /out/antigravity/agy_acp_server.par \
  && test -x /out/antigravity/localharness_external \
  && chmod -R a-w /out/antigravity \
  && rm /tmp/antigravity.zip
RUN curl --retry 5 -fsSL -o /tmp/devin.tar.gz \
  "https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-x86_64-unknown-linux.tar.gz" \
  && printf '%s  /tmp/devin.tar.gz\n' "$DEVIN_SHA256_AMD64" | sha256sum -c - \
  && tar -xzf /tmp/devin.tar.gz -C /tmp bin/devin \
  && install -m 0555 /tmp/bin/devin /out/bin/devin \
  && rm -rf /tmp/devin.tar.gz /tmp/bin

# ─────────────────────────────── runtime ────────────────────────────────────
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime-base

# Install the baseline Git, Python and native build toolchain.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates git openssh-client tini \
    build-essential curl pkg-config python3 python3-dev python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
# `python` as well as `python3` — plenty of tooling still spawns the unsuffixed name.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Install Chrome's headless shared-library closure without GTK or Xvfb.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libudev1 libvulkan1 \
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

# Exact pins keep the published runtime table truthful.
ARG CLAUDE_ACP_VERSION=0.76.0
ARG CODEX_ACP_VERSION=1.11.0-agentconnect.1
ARG DEEPSEEK_HARNESS_ACP_VERSION=0.4.30
ARG AGENT_BROWSER_VERSION=0.37.1

# Global installs give `--k8s` fixed PATH binaries without registry egress at spawn time.
RUN npm install --global --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}" \
  "@agentconnect.md/codex-acp@${CODEX_ACP_VERSION}" \
  "@openma/deepseek-harness-acp@${DEEPSEEK_HARNESS_ACP_VERSION}" \
  && npm cache clean --force

# Install agent-browser and retain only its current platform's native binary.
RUN npm install --global --no-fund --no-audit "agent-browser@${AGENT_BROWSER_VERSION}" \
  && keep="$(readlink -f /usr/local/bin/agent-browser)" \
  && case "$keep" in */agent-browser-*) ;; *) echo "agent-browser bin link resolved to $keep" >&2; exit 1 ;; esac \
  && find /usr/local/lib/node_modules/agent-browser/bin -type f -name 'agent-browser-*' ! -path "$keep" -delete \
  && npm cache clean --force \
  && agent-browser --version

# Generate the pinned DSH preset with web search disabled; see src/shim/dsh-preset.ts.
RUN --mount=type=bind,source=docker/runtime-sandbox/bake-dsh-preset.mjs,target=/tmp/bake-dsh-preset.mjs \
  node /tmp/bake-dsh-preset.mjs /opt/agentconnect/dsh/agent-presets/standard-no-search \
  && chown -R root:root /opt/agentconnect/dsh \
  && chmod -R a-w /opt/agentconnect/dsh

# Git invokes this immutable wrapper to run the credential bundle from the final image.
RUN mkdir -p /opt/agentconnect/bin \
  && printf '#!/bin/sh\n# agentconnect git credential helper — see src/shim/git-credential.ts.\nexec node /opt/agentconnect/shim/git-credential.js "$@"\n' \
    > /opt/agentconnect/bin/git-credential \
  && chown -R root:root /opt/agentconnect/bin \
  && chmod 0555 /opt/agentconnect/bin /opt/agentconnect/bin/git-credential

# The token-aware gh wrapper in the final image delegates to this pinned binary.
COPY --from=gh-cli --chown=0:0 /out/gh /usr/local/bin/gh

# Only /opt/agentconnect/pathbin is prepended to runtime PATH; the final image supplies its gh wrapper.
RUN mkdir -p /opt/agentconnect/pathbin \
  && chmod 0555 /opt/agentconnect/pathbin

# Preserve the downloader's immutable Chrome modes; chmod here would duplicate the browser layer.
COPY --from=chrome --chown=0:0 /out /opt/agentconnect/browser

# A bare agent-browser install uses baked Chrome; other arguments reach the real CLI.
RUN printf '%s\n' \
  '#!/bin/sh' \
  '# agentconnect: this sandbox bakes Chrome, so a bare `install` has nothing to fetch. See runtime-sandbox.Dockerfile.' \
  '# Defaulted here too, not only in ENV: an ACP child is spawned from an allowlist, so the image env may not reach it.' \
  ': "${AGENT_BROWSER_EXECUTABLE_PATH:=/opt/agentconnect/browser/chrome}"' \
  'export AGENT_BROWSER_EXECUTABLE_PATH' \
  'if [ "$1" = install ]; then' \
  '  shift' \
  '  case "$*" in' \
  '  ""|-d|--with-deps)' \
  '    echo "agent-browser install: Chrome is already installed in this sandbox at $AGENT_BROWSER_EXECUTABLE_PATH"' \
  '    exit 0' \
  '    ;;' \
  '  esac' \
  '  exec /usr/local/bin/agent-browser install "$@"' \
  'fi' \
  'exec /usr/local/bin/agent-browser "$@"' \
  > /opt/agentconnect/pathbin/agent-browser \
  && chown root:root /opt/agentconnect/pathbin/agent-browser \
  && chmod 0555 /opt/agentconnect/pathbin/agent-browser

# Fixed uid/gid keep workspace volumes readable across image upgrades.
RUN groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --home-dir /agent --shell /usr/sbin/nologin --create-home agent \
  && chown 10001:10001 /agent

# The non-root shim binds its daemon tunnel sockets in this private runtime directory.
RUN mkdir -p /run/agentconnect \
  && chown 10001:10001 /run/agentconnect \
  && chmod 0700 /run/agentconnect

# Probe the installed runtimes to bake their declared capabilities into the base image.
COPY docker/runtime-sandbox/generate-runtime-table.mjs /opt/agentconnect/bin/generate-runtime-table.mjs
COPY docker/runtime-sandbox/installed-runtimes.json /opt/agentconnect/runtime/installed-runtimes.json
# Probe as the runtime user in a disposable HOME and cwd, leaving /agent clean.
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
# The shim forwards this browser path and provider configuration through its runtime environment allowlist.
ENV HOME=/agent \
  AGENT_BROWSER_EXECUTABLE_PATH=/opt/agentconnect/browser/chrome \
  AC_SHIM_WORKSPACE_ROOT=/agent \
  AC_SHIM_PORT=8085 \
  npm_config_update_notifier=false \
  NODE_OPTIONS=--dns-result-order=ipv4first
EXPOSE 8085
WORKDIR /agent
USER 10001:10001

# The final image supplies the shim; tini reaps children and forwards termination signals.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agentconnect/shim/index.js"]

# Codex needs --argv0 to re-enter its sandbox while its credential directory stays hidden.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS bubblewrap-builder
ARG BUBBLEWRAP_VERSION=0.11.2
ARG BUBBLEWRAP_SHA256=69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl gcc libc6-dev meson pkg-config libcap-dev xz-utils \
  && curl -fsSL --retry 5 "https://github.com/containers/bubblewrap/releases/download/v${BUBBLEWRAP_VERSION}/bubblewrap-${BUBBLEWRAP_VERSION}.tar.xz" -o /tmp/bubblewrap.tar.xz \
  && printf '%s  %s\n' "${BUBBLEWRAP_SHA256}" /tmp/bubblewrap.tar.xz | sha256sum --check --strict \
  && mkdir /src \
  && tar -xJf /tmp/bubblewrap.tar.xz -C /src --strip-components=1 \
  && meson setup /build /src --prefix=/usr/local -Dman=disabled -Dtests=false \
    -Dselinux=disabled -Dbash_completion=disabled -Dzsh_completion=disabled -Dsupport_setuid=false \
  && meson compile -C /build \
  && DESTDIR=/out meson install -C /build

# Self-hosted daemon VMs add the broader runtime catalog, native shields and Docker.
FROM runtime-base AS runtime-sandbox-full-base
USER root
ARG CLINE_VERSION=3.0.61
ARG PI_ACP_VERSION=0.0.33
ARG PI_VERSION=0.80.6
ARG OPENCODE_VERSION=1.17.18
ARG QWEN_CODE_VERSION=0.23.1
ARG COPILOT_VERSION=1.0.83
ARG GROK_VERSION=1.0.24
ARG QODER_VERSION=1.1.14
ARG QODER_CN_VERSION=1.1.2
ARG DOCKER_VERSION=5:29.8.0-1~debian.12~bookworm
ARG CONTAINERD_VERSION=2.3.5-1~debian.12~bookworm
ARG DOCKER_BUILDX_VERSION=0.37.0-1~debian.12~bookworm
ARG DOCKER_COMPOSE_VERSION=5.5.1-1~debian.12~bookworm
RUN apt-get update \
  && apt-get install --no-install-recommends -y libcap2 socat ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bubblewrap-builder --chown=0:0 /out/usr/local/bin/bwrap /usr/local/bin/bwrap
RUN bwrap --help | rg -- '--argv0'

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
# Antigravity resolves its local harness relative to the ACP executable.
COPY --from=full-native-runtimes --chown=0:0 /out/antigravity/ /opt/agentconnect/runtimes/antigravity/
RUN printf '%s\n' '#!/bin/sh' \
  'exec /opt/agentconnect/runtimes/antigravity/agy_acp_server.par "$@"' > /usr/local/bin/antigravity-acp \
  && chmod 0555 /usr/local/bin/antigravity-acp

# Docker's signed Debian repository supplies exact versions; the image never starts dockerd automatically.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod 0644 /etc/apt/keyrings/docker.asc \
  && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n' \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install --no-install-recommends -y \
    "docker-ce=${DOCKER_VERSION}" "docker-ce-cli=${DOCKER_VERSION}" \
    "containerd.io=${CONTAINERD_VERSION}" "docker-buildx-plugin=${DOCKER_BUILDX_VERSION}" \
    "docker-compose-plugin=${DOCKER_COMPOSE_VERSION}" sudo \
  && rm -rf /var/lib/apt/lists/* \
  && dockerd --version && docker --version && docker buildx version && docker compose version

# VM users can start Docker on demand without unrestricted sudo.
RUN usermod --append --groups docker agent \
  && printf 'agent ALL=(root) NOPASSWD: /usr/bin/dockerd\n' > /etc/sudoers.d/agent-dockerd \
  && chmod 0440 /etc/sudoers.d/agent-dockerd \
  && visudo --check --file /etc/sudoers.d/agent-dockerd

# Rebuild the declared table from the full image's explicitly installed runtime catalog.
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

# Keep the pool dependency image as the default build target.
FROM runtime-base AS runtime-sandbox-base
