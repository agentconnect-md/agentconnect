-- Centralized tool management — MCP provider registry (docs/designs/centralized-tool-management.md).
-- CP owns MCP provider definitions; the relay reverse-proxies agent calls so the upstream
-- credential never reaches the daemon/agent. mcp_provider_secret mirrors bot_secret (secret
-- side-table read only via a store, never in a DTO). mcp_provider.id is UUID (it rides the wire
-- as rc/mcp-assign.providerId).

-- CreateEnum
CREATE TYPE "public"."McpTransport" AS ENUM ('http', 'sse');

-- CreateEnum
CREATE TYPE "public"."McpVisibility" AS ENUM ('org', 'selected');

-- CreateTable
CREATE TABLE "public"."mcp_provider" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" "public"."McpTransport" NOT NULL DEFAULT 'http',
    "url" TEXT NOT NULL,
    "visibility" "public"."McpVisibility" NOT NULL DEFAULT 'org',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."mcp_provider_secret" (
    "mcpProviderId" UUID NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "mcp_provider_secret_pkey" PRIMARY KEY ("mcpProviderId")
);

-- CreateTable
CREATE TABLE "public"."mcp_grant" (
    "id" TEXT NOT NULL,
    "mcpProviderId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_provider_orgId_idx" ON "public"."mcp_provider"("orgId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_provider_orgId_name_key" ON "public"."mcp_provider"("orgId" ASC, "name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_grant_key_key" ON "public"."mcp_grant"("key" ASC);

-- CreateIndex
CREATE INDEX "mcp_grant_mcpProviderId_idx" ON "public"."mcp_grant"("mcpProviderId" ASC);

-- AddForeignKey
ALTER TABLE "public"."mcp_provider" ADD CONSTRAINT "mcp_provider_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mcp_provider" ADD CONSTRAINT "mcp_provider_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mcp_provider_secret" ADD CONSTRAINT "mcp_provider_secret_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "public"."mcp_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mcp_grant" ADD CONSTRAINT "mcp_grant_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "public"."mcp_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
