# Build for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner): built online, scanned with no network.
# Node 24.12 is the floor in .nvmrc and package.json#engines; pnpm 11.19.0 is the packageManager pin.
FROM node:24.12-bookworm
ENV CI=true \
  DEBIAN_FRONTEND=noninteractive \
  NEXT_TELEMETRY_DISABLED=1 \
  DO_NOT_TRACK=1 \
  CHECKPOINT_DISABLE=1 \
  COREPACK_HOME=/opt/corepack

# git for the workspace suites; bubblewrap, socat and ripgrep for the srt sandbox suites; postgresql so the control plane can run offline.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl git bash procps python3 jq bubblewrap socat ripgrep postgresql \
  && rm -rf /var/lib/apt/lists/*

# pnpm comes from corepack at the pinned version, cached in COREPACK_HOME so it keeps resolving offline.
RUN corepack enable && corepack install --global pnpm@11.19.0 && pnpm --version

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# The only place dependencies are fetched: the whole workspace, exactly as the lockfile says.
RUN pnpm install --frozen-lockfile

# Generate the control plane's Prisma client (gitignored output), then build every package.
RUN pnpm --filter @agentconnect.md/control-plane prisma:generate
RUN pnpm build

# Prove the image works with the small pure unit suites; a failing test warns but does not abort the build.
RUN (timeout 900 pnpm --filter @agentconnect.md/protocol --filter @agentconnect.md/relay test:unit --maxWorkers=2 \
  || echo "WARNING: unit tests reported failures")

CMD ["bash"]
