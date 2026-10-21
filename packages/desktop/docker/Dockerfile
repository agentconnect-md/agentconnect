# syntax=docker/dockerfile:1.7
# Linux desktop Computer: Xvfb + Xfce + Firefox ESR with agentconnect-desktop (computer-use.md §3.8); context is the repo root.
#   docker build -f packages/desktop/docker/Dockerfile -t agentconnect-desktop .

# The bundle is plain JavaScript, so it is built once on the build platform for every target arch.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS bundle
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable \
  && printf 'fetch-retries=5\nfetch-retry-maxtimeout=600000\nfetch-retry-mintimeout=20000\nfetch-timeout=600000\n' >> /root/.npmrc
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.mjs ./
COPY patches/ patches/
COPY scripts/ scripts/
COPY packages/protocol/package.json packages/protocol/
COPY packages/connection/package.json packages/connection/
COPY packages/desktop/package.json packages/desktop/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts --filter "@agentconnect.md/desktop..."
COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/connection/ packages/connection/
COPY packages/desktop/ packages/desktop/
RUN pnpm --filter @agentconnect.md/desktop bundle

FROM debian:trixie-slim AS desktop

ARG NODE_VERSION=24.12.0
ARG NODE_SHA256_ARM64=a06d42807fb500f7459e5f3fa6cb431447352826ee6f07e14adfeec58a1b3210
ARG NODE_SHA256_X64=bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd
ARG TARGETARCH
ARG VERSION=dev

LABEL org.opencontainers.image.title="AgentConnect desktop" \
  org.opencontainers.image.description="A Linux desktop (Xvfb, Xfce, Firefox ESR) that registers as an AgentConnect Computer" \
  org.opencontainers.image.source="https://github.com/agentconnect-md/agentconnect" \
  org.opencontainers.image.version="${VERSION}"
# No licenses label: the daemon is Apache-2.0, but the Debian packages keep their own (/usr/share/doc/*/copyright).

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
# Nothing here renders with OpenGL (Firefox draws in software), so Mesa's LLVM backend and the CJK serif faces stay out.
COPY packages/desktop/docker/dpkg-excludes /etc/dpkg/dpkg.cfg.d/agentconnect-desktop
RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb x11-xserver-utils x11-utils xauth dbus-x11 at-spi2-core wmctrl \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal \
  firefox-esr fonts-noto-cjk fonts-dejavu-core \
  ca-certificates tini wget xz-utils procps \
  && rm -rf /var/lib/apt/lists/* /var/cache/debconf/*-old /var/log/apt /var/log/dpkg.log

# Pinned, sha256-verified official Node.js for the target arch, without npm or corepack.
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64) node=arm64; sum=$NODE_SHA256_ARM64;; amd64) node=x64; sum=$NODE_SHA256_X64;; *) echo "unsupported $arch"; exit 1;; esac; \
    wget -q -O /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share' --exclude='*/lib/node_modules' \
      --exclude='*/bin/npm' --exclude='*/bin/npx' --exclude='*/bin/corepack' --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    rm /tmp/node.tar.xz; node --version

COPY --from=bundle /app/packages/desktop/bundle/agentconnect-desktop.mjs /app/packages/desktop/bundle/agentconnect-desktop.mjs.LEGAL.txt /opt/agentconnect/
# The pinned Cua Driver lives in the image; GPL ffmpeg is not bundled, the daemon downloads it on first start (§11).
RUN AGENTCONNECT_DESKTOP_HOME=/opt/agentconnect/tools node /opt/agentconnect/agentconnect-desktop.mjs install-driver \
  && rm -f /opt/agentconnect/tools/cua-driver/*/libcua_driver_sdk.so /opt/agentconnect/tools/cua-driver/*/cua_driver_node_runtime.node \
  && chmod -R a+rX /opt/agentconnect \
  && printf '#!/bin/sh\nexec node /opt/agentconnect/agentconnect-desktop.mjs "$@"\n' > /usr/local/bin/agentconnect-desktop \
  && chmod 755 /usr/local/bin/agentconnect-desktop

COPY packages/desktop/docker/firefox.prefs /etc/firefox-esr/agentconnect.js
RUN useradd --create-home --uid 1000 --shell /bin/bash desktop && mkdir -p -m 1777 /tmp/.X11-unix
COPY --chmod=755 packages/desktop/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER desktop
WORKDIR /home/desktop
# The isolation is declared rather than sniffed: /.dockerenv is absent under some runtimes (Podman, Kubernetes).
ENV RESOLUTION=1600x900x24 LISTEN_HOST=0.0.0.0 PORT=7681 BROWSER=firefox-esr \
  AGENTCONNECT_DESKTOP_HOME=/home/desktop/.agentconnect/desktop AGENTCONNECT_DESKTOP_ISOLATION=container
# Home holds the daemon data dir (config, Computer key, audit) and the browser profile.
VOLUME /home/desktop
EXPOSE 7681
# Doctor inside the running daemon: display, driver, screenshot, capture, and the Computer key; unreachable is unhealthy.
HEALTHCHECK --interval=60s --timeout=45s --start-period=120s --start-interval=5s --retries=3 \
  CMD agentconnect-desktop doctor --json --daemon --port "$PORT" > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
