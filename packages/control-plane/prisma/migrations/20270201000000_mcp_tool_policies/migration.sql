-- Per-agent MCP tool permissions (docs/designs/mcp-tool-permissions.md §4, §5.1).
ALTER TABLE "mcp_grant" ADD COLUMN "agentId" UUID;
ALTER TABLE "mcp_grant" ADD COLUMN "custody" TEXT;

CREATE TABLE "agent_mcp_tool_policy" (
    "agentId" UUID NOT NULL,
    "mcpProviderId" UUID NOT NULL,
    "groups" JSONB NOT NULL,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "allowTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "askTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "catalogFetchedAt" TIMESTAMPTZ(6),
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_mcp_tool_policy_pkey" PRIMARY KEY ("agentId","mcpProviderId")
);

CREATE TABLE "mcp_tool_catalog" (
    "mcpProviderId" UUID NOT NULL,
    "tools" JSONB NOT NULL,
    "fetchedAt" TIMESTAMPTZ(6) NOT NULL,
    "failure" TEXT,

    CONSTRAINT "mcp_tool_catalog_pkey" PRIMARY KEY ("mcpProviderId")
);

CREATE INDEX "mcp_grant_mcpProviderId_agentId_idx" ON "mcp_grant"("mcpProviderId", "agentId");
CREATE INDEX "mcp_grant_agentId_idx" ON "mcp_grant"("agentId");
CREATE INDEX "agent_mcp_tool_policy_mcpProviderId_idx" ON "agent_mcp_tool_policy"("mcpProviderId");

ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mcp_tool_policy" ADD CONSTRAINT "agent_mcp_tool_policy_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mcp_tool_policy" ADD CONSTRAINT "agent_mcp_tool_policy_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "mcp_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_tool_catalog" ADD CONSTRAINT "mcp_tool_catalog_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "mcp_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
