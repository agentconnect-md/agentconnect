-- Durable generation-fenced webchat authority and one-time MCP invocation
-- idempotency. Only peppered assertion hashes are persisted.

ALTER TABLE "webchat_conversation"
  ADD COLUMN "delegationGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "McpInvocationStatus" AS ENUM (
  'issued',
  'running',
  'succeeded',
  'failed',
  'ambiguous'
);

CREATE TABLE "webchat_mcp_delegation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "conversationId" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "userId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "agentId" UUID NOT NULL,
  "daemonId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "revokedReason" TEXT,

  CONSTRAINT "webchat_mcp_delegation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mcp_invocation" (
  "id" UUID NOT NULL,
  "delegationId" UUID NOT NULL,
  "assertionHash" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "toolName" TEXT,
  "status" "McpInvocationStatus" NOT NULL DEFAULT 'issued',
  "assertionExpires" TIMESTAMPTZ(6) NOT NULL,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "responseStatus" INTEGER,
  "responseBytes" BYTEA,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mcp_invocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webchat_mcp_delegation_conversationId_generation_key"
  ON "webchat_mcp_delegation"("conversationId", "generation");
CREATE INDEX "webchat_mcp_delegation_conversationId_revokedAt_idx"
  ON "webchat_mcp_delegation"("conversationId", "revokedAt");
CREATE INDEX "webchat_mcp_delegation_expiresAt_idx"
  ON "webchat_mcp_delegation"("expiresAt");

CREATE UNIQUE INDEX "mcp_invocation_assertionHash_key"
  ON "mcp_invocation"("assertionHash");
CREATE INDEX "mcp_invocation_delegationId_createdAt_idx"
  ON "mcp_invocation"("delegationId", "createdAt");
CREATE INDEX "mcp_invocation_status_assertionExpires_idx"
  ON "mcp_invocation"("status", "assertionExpires");

ALTER TABLE "webchat_mcp_delegation"
  ADD CONSTRAINT "webchat_mcp_delegation_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "webchat_conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_mcp_delegation"
  ADD CONSTRAINT "webchat_mcp_delegation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app_user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_mcp_delegation"
  ADD CONSTRAINT "webchat_mcp_delegation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "org"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_mcp_delegation"
  ADD CONSTRAINT "webchat_mcp_delegation_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_mcp_delegation"
  ADD CONSTRAINT "webchat_mcp_delegation_daemonId_fkey"
  FOREIGN KEY ("daemonId") REFERENCES "daemon"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mcp_invocation"
  ADD CONSTRAINT "mcp_invocation_delegationId_fkey"
  FOREIGN KEY ("delegationId") REFERENCES "webchat_mcp_delegation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
