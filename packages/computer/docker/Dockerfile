# syntax=docker/dockerfile:1.7
# Linux desktop Computer: Xvfb + Xfce + Chromium, LibreOffice and dev tools with agentconnect-computer (computer-use.md §3.8); context is the repo root.
#   docker build -f packages/computer/docker/Dockerfile -t agentconnect-computer .

# The bundle is plain JavaScript, so it is built once on the build platform for every target arch.
FROM --platform=$BUILDPLATFORM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS bundle
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global corepack@0.36.0 && corepack enable \
  && printf 'fetch-retries=5\nfetch-retry-maxtimeout=600000\nfetch-retry-mintimeout=20000\nfetch-timeout=600000\n' >> /root/.npmrc
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.mjs ./
COPY patches/ patches/
COPY scripts/ scripts/
COPY packages/protocol/package.json packages/protocol/
COPY packages/connection/package.json packages/connection/
COPY packages/computer/package.json packages/computer/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --ignore-scripts --filter "@agentconnect.md/computer..."
COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/connection/ packages/connection/
COPY packages/computer/ packages/computer/
RUN pnpm --filter @agentconnect.md/computer bundle

FROM debian:trixie-slim AS computer

# Dependabot can't see these ARGs: bump the version and both SHASUMS256 sums together with the bundle stage's node FROM.
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_ARM64=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
ARG NODE_SHA256_X64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG TARGETARCH
ARG VERSION=dev

LABEL org.opencontainers.image.title="AgentConnect computer" \
  org.opencontainers.image.description="A Linux desktop (Xvfb, Xfce, Chromium, LibreOffice) that registers as an AgentConnect Computer" \
  org.opencontainers.image.source="https://github.com/agentconnect-md/agentconnect" \
  org.opencontainers.image.version="${VERSION}"
# No licenses label: the daemon is Apache-2.0, but the Debian packages keep their own (/usr/share/doc/*/copyright).

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
# Nothing here renders with OpenGL (Chromium and LibreOffice draw in software), so Mesa's LLVM backend and the CJK serif faces stay out.
COPY packages/computer/docker/dpkg-excludes /etc/dpkg/dpkg.cfg.d/agentconnect-computer
RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb x11-xserver-utils x11-utils xauth dbus-x11 at-spi2-core wmctrl \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal \
  mousepad ristretto xarchiver librsvg2-common \
  chromium libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
  fonts-noto-cjk fonts-dejavu-core fonts-liberation \
  python3 python3-pip python3-venv golang-go rustc cargo build-essential pkg-config \
  git gh openssh-client curl jq poppler-utils zip unzip \
  ca-certificates tini wget xz-utils procps \
  && rm -rf /var/lib/apt/lists/* /var/cache/debconf/*-old /var/log/apt /var/log/dpkg.log

# Pinned, sha256-verified official Node.js for the target arch, with npm and corepack's pnpm and yarn shims.
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64) node=arm64; sum=$NODE_SHA256_ARM64;; amd64) node=x64; sum=$NODE_SHA256_X64;; *) echo "unsupported $arch"; exit 1;; esac; \
    wget -q -O /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share' --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    rm /tmp/node.tar.xz; npm install --global corepack@0.36.0; corepack enable pnpm yarn; node --version; npm --version

COPY --from=bundle /app/packages/computer/bundle/agentconnect-computer.mjs /app/packages/computer/bundle/agentconnect-computer.mjs.LEGAL.txt /opt/agentconnect/
# The pinned Cua Driver lives in the image; GPL ffmpeg is not bundled, the daemon downloads it on first start (§11).
RUN AGENTCONNECT_COMPUTER_HOME=/opt/agentconnect/tools node /opt/agentconnect/agentconnect-computer.mjs install-driver \
  && rm -f /opt/agentconnect/tools/cua-driver/*/libcua_driver_sdk.so /opt/agentconnect/tools/cua-driver/*/cua_driver_node_runtime.node \
  && chmod -R a+rX /opt/agentconnect \
  && printf '#!/bin/sh\nexec node /opt/agentconnect/agentconnect-computer.mjs "$@"\n' > /usr/local/bin/agentconnect-computer \
  && chmod 755 /usr/local/bin/agentconnect-computer

# Chromium's launcher sources /etc/chromium.d, which reads the egress forwarder's port in a managed pod (§15.4).
COPY packages/computer/docker/chromium-flags /etc/chromium.d/agentconnect
COPY packages/computer/docker/chromium-policies.json /etc/chromium/policies/managed/agentconnect.json
# A bottom launcher dock on a dark backdrop with no desktop icons, for a profile with no Xfce settings of its own yet.
COPY packages/computer/docker/xfce4-panel.xml /etc/xdg/xfce4/panel/default.xml
COPY packages/computer/docker/xfce4-desktop.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
COPY packages/computer/docker/backdrop.svg /usr/share/backgrounds/agentconnect/backdrop.svg
RUN useradd --create-home --uid 1000 --shell /bin/bash computer && mkdir -p -m 1777 /tmp/.X11-unix
COPY --chmod=755 packages/computer/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER computer
WORKDIR /home/computer
# 1280x800 is the screenshot size (§5.3); isolation is declared, since /.dockerenv is absent under Podman and Kubernetes.
# npm -g, go install and cargo install land in the home volume; Debian's Go would otherwise refuse a newer go.mod.
ENV RESOLUTION=1280x800x24 LISTEN_HOST=0.0.0.0 PORT=7681 BROWSER=chromium \
  AGENTCONNECT_COMPUTER_HOME=/home/computer/.agentconnect/computer AGENTCONNECT_COMPUTER_ISOLATION=container \
  NPM_CONFIG_PREFIX=/home/computer/.local GOTOOLCHAIN=auto PATH=/home/computer/.local/bin:/home/computer/go/bin:/home/computer/.cargo/bin:$PATH
# Home holds the daemon data dir (config, Computer key, audit), the browser profile, and user-installed tools.
VOLUME /home/computer
EXPOSE 7681
# Doctor inside the running daemon: display, driver, screenshot, capture, and the Computer key; unreachable is unhealthy.
HEALTHCHECK --interval=60s --timeout=45s --start-period=120s --start-interval=5s --retries=3 \
  CMD agentconnect-computer doctor --json --daemon --port "$PORT" > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
