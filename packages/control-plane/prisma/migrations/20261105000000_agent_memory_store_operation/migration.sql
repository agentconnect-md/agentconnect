CREATE TABLE "agent_memory_store_operation" (
  "agentId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reply" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("agentId", "operationId"),
  FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_memory_store_operation_createdAt_idx" ON "agent_memory_store_operation"("createdAt");
CREATE INDEX "agent_memory_store_operation_orgId_idx" ON "agent_memory_store_operation"("orgId");
