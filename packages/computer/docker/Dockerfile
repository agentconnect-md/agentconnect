# syntax=docker/dockerfile:1.7
# Linux desktop Computer: Xvfb + Xfce + Google Chrome, LibreOffice and dev tools with agentconnect-computer (computer-use.md §3.8); context is the repo root.
#   docker build -f packages/computer/docker/Dockerfile -t agentconnect-computer .

# The bundle is plain JavaScript, so it is built once on the build platform for every target arch.
FROM --platform=$BUILDPLATFORM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS bundle
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
# The pinned Chrome DevTools MCP of the browser tier (§5.8), from the workspace lockfile: one package that bundles its dependencies.
RUN cp -RL packages/computer/node_modules/chrome-devtools-mcp /app/chrome-devtools-mcp \
  && test "$(node -p 'require("/app/chrome-devtools-mcp/package.json").version')" = 1.13.0

FROM debian:trixie-slim AS computer

# Dependabot can't see these ARGs: bump the version and both SHASUMS256 sums together with the bundle stage's node FROM.
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_ARM64=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
ARG NODE_SHA256_X64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
# Nothing here renders with OpenGL (Chrome and LibreOffice draw in software), so Mesa's LLVM backend and the CJK serif faces stay out.
COPY packages/computer/docker/dpkg-excludes /etc/dpkg/dpkg.cfg.d/agentconnect-computer
# sudo grants nothing until seed-system.sh writes a rule; apt reads https, a managed pod's only web port; Chrome lives in /usr for a system volume (§3.8).
RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb x11-xserver-utils x11-utils xauth dbus-x11 at-spi2-core wmctrl \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal \
  mousepad ristretto xarchiver librsvg2-common \
  libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3 \
  fonts-noto-cjk fonts-dejavu-core fonts-liberation \
  python3 python3-pip python3-venv golang-go rustc cargo build-essential pkg-config \
  git gh openssh-client curl jq poppler-utils zip unzip \
  ca-certificates tini wget xz-utils procps sudo \
  && sed -i 's|http://deb.debian.org|https://deb.debian.org|' /etc/apt/sources.list.d/debian.sources \
  && wget -q -O /usr/share/keyrings/google-chrome.asc https://dl.google.com/linux/linux_signing_key.pub \
  && printf 'Types: deb\nURIs: https://dl.google.com/linux/chrome-stable/deb/\nSuites: stable\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/google-chrome.asc\n' \
    "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/google-chrome.sources \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -f /usr/share/keyrings/google-chrome.asc && grep -q '^Signed-By: /usr/share/keyrings/google-chrome.gpg' /etc/apt/sources.list.d/google-chrome.sources \
  && mv /opt/google /usr/lib/google && ln -s /usr/lib/google /opt/google \
  && rm -rf /var/lib/apt/lists/* /var/cache/debconf/*-old /var/log/apt /var/log/dpkg.log

# Pinned, sha256-verified official Node.js with npm and corepack's shims, in /opt and linked into /usr/local/bin: a desktop whose /usr is a volume runs the image's Node (§3.8).
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64) node=arm64; sum=$NODE_SHA256_ARM64;; amd64) node=x64; sum=$NODE_SHA256_X64;; *) echo "unsupported $arch"; exit 1;; esac; \
    wget -q -O /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share' --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    rm /tmp/node.tar.xz; export PATH="/opt/node/bin:$PATH"; npm install --global corepack@0.36.0; corepack enable pnpm yarn; \
    ln -s /opt/node/bin/* /usr/local/bin/; node --version; npm --version

COPY --from=bundle /app/packages/computer/bundle/agentconnect-computer.mjs /app/packages/computer/bundle/agentconnect-computer.mjs.LEGAL.txt /opt/agentconnect/
# Beside the daemon, which finds it there; never fetched at run time, and not on a system volume (§3.8).
COPY --from=bundle /app/chrome-devtools-mcp /opt/agentconnect/chrome-devtools-mcp
# The pinned Cua Driver lives in the image; GPL ffmpeg is not bundled, the daemon downloads it on first start (§11).
RUN AGENTCONNECT_COMPUTER_HOME=/opt/agentconnect/tools node /opt/agentconnect/agentconnect-computer.mjs install-driver \
  && rm -f /opt/agentconnect/tools/cua-driver/*/libcua_driver_sdk.so /opt/agentconnect/tools/cua-driver/*/cua_driver_node_runtime.node \
  && chmod -R a+rX /opt/agentconnect \
  && printf '#!/bin/sh\nexec node /opt/agentconnect/agentconnect-computer.mjs "$@"\n' > /usr/local/bin/agentconnect-computer \
  && chmod 755 /usr/local/bin/agentconnect-computer
# The form-fill extension, force-installed by managed policy from a local CRX; its id follows the extension build (§8).
RUN node /opt/agentconnect/agentconnect-computer.mjs install-extension /opt/agentconnect/extension \
  --policy-dir /etc/opt/chrome/policies/managed --form-fill-port 7682 && chmod -R a+rX /opt/agentconnect/extension

# Chrome's launcher reads no flags file: the browser's flags come from the daemon's launcher, which every start goes through (§3.10).
COPY packages/computer/docker/browser-policies.json /etc/opt/chrome/policies/managed/agentconnect.json
# Chromium's copy serves a system volume that still runs the Chromium it was seeded with (§3.8).
RUN mkdir -p /etc/chromium/policies/managed && cp /etc/opt/chrome/policies/managed/*.json /etc/chromium/policies/managed/
# A bottom launcher dock on a dark backdrop with no desktop icons, for a profile with no Xfce settings of its own yet.
COPY packages/computer/docker/xfce4-panel.xml /etc/xdg/xfce4/panel/default.xml
COPY packages/computer/docker/xfce4-desktop.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
COPY packages/computer/docker/backdrop.svg /usr/share/backgrounds/agentconnect/backdrop.svg
RUN useradd --create-home --uid 1000 --shell /bin/bash computer && mkdir -p -m 1777 /tmp/.X11-unix
# Under /opt like the daemon, so they follow the image on a desktop whose /usr, /etc and /var are a volume (§3.8); image-owned lists what else does.
COPY --chmod=755 packages/computer/docker/entrypoint.sh packages/computer/docker/seed-system.sh /opt/agentconnect/
COPY --chmod=644 packages/computer/docker/image-owned /opt/agentconnect/image-owned

USER computer
WORKDIR /home/computer
# Screenshot size (§5.3), declared isolation, the image's browser setup (§3.8), and tool installs that land in the home volume.
ENV RESOLUTION=1280x800x24 LISTEN_HOST=0.0.0.0 PORT=7681 FORM_FILL_PORT=7682 BROWSER=google-chrome \
  AGENTCONNECT_COMPUTER_HOME=/home/computer/.agentconnect/computer AGENTCONNECT_COMPUTER_ISOLATION=container AGENTCONNECT_COMPUTER_IMAGE=1 \
  NPM_CONFIG_PREFIX=/home/computer/.local GOTOOLCHAIN=auto PATH=/home/computer/.local/bin:/home/computer/go/bin:/home/computer/.cargo/bin:$PATH
# Home holds the daemon data dir (config, Computer key, audit), the browser profile, and user-installed tools.
VOLUME /home/computer
EXPOSE 7681
# Doctor inside the running daemon: display, driver, screenshot, capture, and the Computer key; unreachable is unhealthy.
HEALTHCHECK --interval=60s --timeout=45s --start-period=120s --start-interval=5s --retries=3 \
  CMD agentconnect-computer doctor --json --daemon --port "$PORT" > /dev/null || exit 1
# After every RUN: each RUN sees a declared ARG, so a per-release VERSION would rebuild the apt layer on every release.
ARG VERSION=dev
LABEL org.opencontainers.image.title="AgentConnect computer" \
  org.opencontainers.image.description="A Linux desktop (Xvfb, Xfce, Google Chrome, LibreOffice) that registers as an AgentConnect Computer" \
  org.opencontainers.image.source="https://github.com/agentconnect-md/agentconnect" \
  org.opencontainers.image.version="${VERSION}"
# No licenses label: the daemon is Apache-2.0, but the Debian packages keep their own (/usr/share/doc/*/copyright) and Chrome Google's terms.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agentconnect/entrypoint.sh"]
