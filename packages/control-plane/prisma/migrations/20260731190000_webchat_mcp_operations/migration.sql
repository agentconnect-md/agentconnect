DROP TABLE IF EXISTS "mcp_invocation";
DROP TYPE IF EXISTS "McpInvocationStatus";

CREATE TYPE "WebchatMcpOperationStatus" AS ENUM (
  'awaiting_confirmation',
  'executing',
  'completed',
  'failed',
  'ambiguous',
  'stale'
);

CREATE TABLE "webchat_mcp_operation" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "createdAuthorityGeneration" INTEGER NOT NULL,
  "sourceGrantId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "canonicalArguments" JSONB NOT NULL,
  "intentHash" TEXT NOT NULL,
  "status" "WebchatMcpOperationStatus" NOT NULL DEFAULT 'awaiting_confirmation',
  "executionAttemptId" UUID,
  "claimedAt" TIMESTAMPTZ(6),
  "recoveryDeadline" TIMESTAMPTZ(6),
  "boundedResponse" BYTEA,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmationExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "completedAt" TIMESTAMPTZ(6),
  CONSTRAINT "webchat_mcp_operation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webchat_mcp_operation_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "webchat_conversation"("id") ON DELETE CASCADE,
  CONSTRAINT "webchat_mcp_operation_sourceGrantId_fkey"
    FOREIGN KEY ("sourceGrantId") REFERENCES "webchat_mcp_access_grant"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "webchat_mcp_operation_open_intent_key"
  ON "webchat_mcp_operation" ("conversationId", "intentHash")
  WHERE "status" = 'awaiting_confirmation';
CREATE INDEX "webchat_mcp_operation_conversation_status_created_idx"
  ON "webchat_mcp_operation" ("conversationId", "status", "createdAt");
CREATE INDEX "webchat_mcp_operation_status_recovery_idx"
  ON "webchat_mcp_operation" ("status", "recoveryDeadline", "id");

CREATE TABLE "webchat_mcp_transport_receipt" (
  "grantId" UUID NOT NULL,
  "jsonRpcRequestId" TEXT NOT NULL,
  "conversationId" UUID NOT NULL,
  "requestHash" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMPTZ(6),
  CONSTRAINT "webchat_mcp_transport_receipt_pkey" PRIMARY KEY ("grantId", "jsonRpcRequestId"),
  CONSTRAINT "webchat_mcp_transport_receipt_grantId_fkey"
    FOREIGN KEY ("grantId") REFERENCES "webchat_mcp_access_grant"("id") ON DELETE CASCADE,
  CONSTRAINT "webchat_mcp_transport_receipt_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "webchat_mcp_operation"("id") ON DELETE RESTRICT
);

CREATE INDEX "webchat_mcp_transport_receipt_operation_idx"
  ON "webchat_mcp_transport_receipt" ("operationId");
CREATE INDEX "webchat_mcp_transport_receipt_grant_created_idx"
  ON "webchat_mcp_transport_receipt" ("grantId", "createdAt");
