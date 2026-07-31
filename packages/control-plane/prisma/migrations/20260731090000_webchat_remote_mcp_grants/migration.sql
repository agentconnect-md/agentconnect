DROP TABLE IF EXISTS "mcp_invocation";

CREATE TYPE "WebchatMcpGrantStatus" AS ENUM ('pending', 'active', 'revoked', 'expired');

CREATE TABLE "webchat_mcp_access_grant" (
    "id" UUID NOT NULL,
    "authorityId" UUID NOT NULL,
    "descriptorInstanceId" UUID NOT NULL,
    "grantRevision" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "WebchatMcpGrantStatus" NOT NULL DEFAULT 'pending',
    "pendingExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webchat_mcp_access_grant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webchat_mcp_access_grant_authorityId_fkey"
      FOREIGN KEY ("authorityId") REFERENCES "webchat_mcp_delegation"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "webchat_mcp_access_grant_tokenHash_key"
  ON "webchat_mcp_access_grant"("tokenHash");
CREATE UNIQUE INDEX "webchat_mcp_access_grant_descriptorInstanceId_grantRevision_key"
  ON "webchat_mcp_access_grant"("descriptorInstanceId", "grantRevision");
CREATE INDEX "webchat_mcp_access_grant_authorityId_status_idx"
  ON "webchat_mcp_access_grant"("authorityId", "status");
CREATE INDEX "webchat_mcp_access_grant_descriptorInstanceId_status_idx"
  ON "webchat_mcp_access_grant"("descriptorInstanceId", "status");
CREATE INDEX "webchat_mcp_access_grant_status_pendingExpiresAt_idx"
  ON "webchat_mcp_access_grant"("status", "pendingExpiresAt");
CREATE INDEX "webchat_mcp_access_grant_status_expiresAt_idx"
  ON "webchat_mcp_access_grant"("status", "expiresAt");

CREATE TYPE "McpInvocationStatus_new" AS ENUM (
  'awaiting_confirmation', 'issued', 'running', 'succeeded', 'failed', 'ambiguous'
);
ALTER TYPE "McpInvocationStatus" RENAME TO "McpInvocationStatus_old";
ALTER TYPE "McpInvocationStatus_new" RENAME TO "McpInvocationStatus";
DROP TYPE "McpInvocationStatus_old";

CREATE TABLE "mcp_invocation" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "toolName" TEXT,
    "status" "McpInvocationStatus" NOT NULL DEFAULT 'issued',
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "responseStatus" INTEGER,
    "responseBytes" BYTEA,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_invocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mcp_invocation_grantId_fkey"
      FOREIGN KEY ("grantId") REFERENCES "webchat_mcp_access_grant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mcp_invocation_conversationId_id_key"
  ON "mcp_invocation"("conversationId", "id");
CREATE INDEX "mcp_invocation_grantId_createdAt_idx"
  ON "mcp_invocation"("grantId", "createdAt");
CREATE INDEX "mcp_invocation_status_startedAt_id_idx"
  ON "mcp_invocation"("status", "startedAt", "id");
CREATE INDEX "mcp_invocation_status_completedAt_id_idx"
  ON "mcp_invocation"("status", "completedAt", "id");
