# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc .pnpmfile.mjs ./
COPY packages/message/package.json packages/message/tsconfig.json ./packages/message/
COPY packages/message/src ./packages/message/src
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/memory-plugin-mem0/package.json packages/memory-plugin-mem0/tsconfig.json ./packages/memory-plugin-mem0/
COPY packages/memory-plugin-mem0/src ./packages/memory-plugin-mem0/src
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @agentconnect.md/memory-plugin-mem0...
RUN pnpm --filter @agentconnect.md/memory-plugin-mem0 build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 MEM0_DIALECT=cloud MCP_TRANSPORT=http
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs ./
COPY packages/message/package.json ./packages/message/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/memory-plugin-mem0/package.json ./packages/memory-plugin-mem0/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --filter @agentconnect.md/memory-plugin-mem0...
COPY --from=build /app/packages/message/dist ./packages/message/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/memory-plugin-mem0/dist ./packages/memory-plugin-mem0/dist
USER node
EXPOSE 8788
CMD ["node", "packages/memory-plugin-mem0/dist/cli.js"]
