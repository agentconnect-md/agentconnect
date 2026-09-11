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

# Fixed uid/gid keep workspace volumes readable across image upgrades.
RUN groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --home-dir /agent --shell /usr/sbin/nologin --create-home agent \
  && chown 10001:10001 /agent

# The non-root shim binds its daemon tunnel sockets in this private runtime directory.
RUN mkdir -p /run/agentconnect \
  && chown 10001:10001 /run/agentconnect \
  && chmod 0700 /run/agentconnect

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

# The full system base adds native sandbox tools and Docker.
FROM runtime-base AS runtime-sandbox-full-base
USER root
ARG DOCKER_VERSION=5:29.8.0-1~debian.12~bookworm
ARG CONTAINERD_VERSION=2.3.5-1~debian.12~bookworm
ARG DOCKER_BUILDX_VERSION=0.37.0-1~debian.12~bookworm
ARG DOCKER_COMPOSE_VERSION=5.5.1-1~debian.12~bookworm
RUN apt-get update \
  && apt-get install --no-install-recommends -y libcap2 socat ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bubblewrap-builder --chown=0:0 /out/usr/local/bin/bwrap /usr/local/bin/bwrap
RUN bwrap --help | rg -- '--argv0'

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

USER 10001:10001

# Keep the pool dependency image as the default build target.
FROM runtime-base AS runtime-sandbox-base
