CREATE TABLE "agent_memory_mutation" (
  "agentId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "root" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceTurnId" UUID,
  "committedAt" TIMESTAMPTZ(3) NOT NULL,
  "receipt" JSONB NOT NULL,
  PRIMARY KEY ("agentId", "operationId"),
  FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_memory_mutation_agentId_root_committedAt_idx" ON "agent_memory_mutation"("agentId", "root", "committedAt");
CREATE INDEX "agent_memory_mutation_agentId_sourceTurnId_idx" ON "agent_memory_mutation"("agentId", "sourceTurnId");
CREATE INDEX "agent_memory_mutation_orgId_idx" ON "agent_memory_mutation"("orgId");
