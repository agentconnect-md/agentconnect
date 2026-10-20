# Proof of concept: Xvfb + Xfce + Firefox ESR desktop with agentconnect-desktop inside; build from packages/desktop after `pnpm bundle`.
FROM debian:trixie-slim

ARG NODE_VERSION=24.12.0
ARG NODE_SHA256_ARM64=a06d42807fb500f7459e5f3fa6cb431447352826ee6f07e14adfeec58a1b3210
ARG NODE_SHA256_X64=bdebee276e58d0ef5448f3d5ac12c67daa963dd5e0a9bb621a53d1cefbc852fd
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
  xvfb x11-xserver-utils x11-utils xauth dbus-x11 at-spi2-core \
  xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal \
  firefox-esr fonts-noto-cjk fonts-dejavu-core \
  ca-certificates tini wget xz-utils procps \
  && rm -rf /var/lib/apt/lists/*

# Pinned, sha256-verified official Node.js for the target arch.
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64) node=arm64; sum=$NODE_SHA256_ARM64;; amd64) node=x64; sum=$NODE_SHA256_X64;; *) echo "unsupported $arch"; exit 1;; esac; \
    wget -q -O /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*/include' --exclude='*/share'; \
    rm /tmp/node.tar.xz; node --version

COPY bundle/agentconnect-desktop.mjs /opt/agentconnect/agentconnect-desktop.mjs
# Pinned Cua Driver and ffmpeg live in the image; the entrypoint links them into the data dir so first start downloads nothing.
RUN AGENTCONNECT_DESKTOP_HOME=/opt/agentconnect/tools node /opt/agentconnect/agentconnect-desktop.mjs install-driver \
  && AGENTCONNECT_DESKTOP_HOME=/opt/agentconnect/tools node /opt/agentconnect/agentconnect-desktop.mjs install-ffmpeg \
  && chmod -R a+rX /opt/agentconnect

RUN useradd --create-home --uid 1000 --shell /bin/bash desktop && mkdir -p -m 1777 /tmp/.X11-unix
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

USER desktop
WORKDIR /home/desktop
ENV RESOLUTION=1600x900x24 LISTEN_HOST=0.0.0.0 PORT=7681 AGENTCONNECT_DESKTOP_HOME=/home/desktop/.agentconnect/desktop
# Home holds the daemon data dir (config, tokens, audit) and the Firefox profile.
VOLUME /home/desktop
EXPOSE 7681
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
