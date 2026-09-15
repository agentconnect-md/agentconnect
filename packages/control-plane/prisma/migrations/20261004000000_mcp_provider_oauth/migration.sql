-- OAuth-authorized MCP providers (mcp-provider-oauth.md): the per-provider auth mode, the CP's
-- OAuth grant for an upstream, its sealed secrets, and the one-shot authorization state rows.

CREATE TYPE "McpProviderAuth" AS ENUM ('headers', 'oauth2');

ALTER TABLE "mcp_provider" ADD COLUMN "auth" "McpProviderAuth" NOT NULL DEFAULT 'headers';

-- Non-secret discovery results + client identity. The token pair lives in the side-table.
CREATE TABLE "mcp_provider_oauth" (
    "mcpProviderId" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "authorizationEndpoint" TEXT NOT NULL,
    "tokenEndpoint" TEXT NOT NULL,
    "registrationEndpoint" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientId" TEXT NOT NULL,
    "clientSource" TEXT NOT NULL,
    "issParameterSupported" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "connectedByUserId" TEXT,
    "accessExpiresAt" TIMESTAMPTZ(6),
    "tokenVersion" BIGINT NOT NULL DEFAULT 1,
    "refreshLeaseOwner" TEXT,
    "refreshLeaseUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_provider_oauth_pkey" PRIMARY KEY ("mcpProviderId")
);

-- The refresher's sweep: rows due for renewal.
CREATE INDEX "mcp_provider_oauth_status_accessExpiresAt_idx" ON "mcp_provider_oauth"("status", "accessExpiresAt");

ALTER TABLE "mcp_provider_oauth" ADD CONSTRAINT "mcp_provider_oauth_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "mcp_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sealed client secret + token pair: read only through the secret store, never joined by DTO queries.
CREATE TABLE "mcp_provider_oauth_secret" (
    "mcpProviderId" UUID NOT NULL,
    "clientSecret" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,

    CONSTRAINT "mcp_provider_oauth_secret_pkey" PRIMARY KEY ("mcpProviderId")
);

ALTER TABLE "mcp_provider_oauth_secret" ADD CONSTRAINT "mcp_provider_oauth_secret_mcpProviderId_fkey" FOREIGN KEY ("mcpProviderId") REFERENCES "mcp_provider_oauth"("mcpProviderId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-shot start → begin → callback state. Structurally the same row as gitlab_oauth_state.
CREATE TABLE "mcp_provider_oauth_state" (
    "nonce" TEXT NOT NULL,
    "mcpProviderId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "browserHash" TEXT,
    "returnPath" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "expectedIssuer" TEXT NOT NULL,
    "expectedVersion" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_provider_oauth_state_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "mcp_provider_oauth_state_expiresAt_idx" ON "mcp_provider_oauth_state"("expiresAt");
