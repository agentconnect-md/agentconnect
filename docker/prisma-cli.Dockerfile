# syntax=docker/dockerfile:1.7
#
# Generic Prisma migration runner. This image is rebuilt manually only when its
# pinned Prisma/Node stack changes; application releases provide schema and
# migration files at runtime through /migration.
# Compose and Helm keep the published Node 24 image until this Node 26 image is verified and published.
# Publish command (requires a GHCR token with write:packages):
# docker buildx build --platform linux/amd64,linux/arm64 --push -f docker/prisma-cli.Dockerfile -t ghcr.io/example-org/prisma-cli:7.8.0-node26-r1 .
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9

ARG PRISMA_VERSION=7.8.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /opt/prisma-cli \
  && cd /opt/prisma-cli \
  && npm init --yes \
  && npm install --save-exact --omit=dev --omit=peer "prisma@${PRISMA_VERSION}" \
  && npm cache clean --force

COPY docker/prisma-cli.config.ts /opt/prisma-cli/prisma.config.ts

LABEL org.opencontainers.image.description="Pinned Prisma CLI migration runner for AgentConnect" \
  org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /opt/prisma-cli
ENV NODE_ENV=production \
  PATH=/opt/prisma-cli/node_modules/.bin:$PATH

CMD ["prisma", "migrate", "deploy"]
