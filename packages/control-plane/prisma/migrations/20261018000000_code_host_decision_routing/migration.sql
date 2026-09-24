-- Decision routing across the agents watching one GitHub repository (code-host-decisions.md §3.1).
BEGIN;

CREATE TABLE "code_host_decision_routing" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "repoId" BIGINT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "decisionId" UUID NOT NULL,
    "rules" JSONB NOT NULL,
    "otherwise" JSONB NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "evaluationAgentId" UUID,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "code_host_decision_routing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "code_host_decision_routing_provider" CHECK ("provider" = 'github'),
    CONSTRAINT "code_host_decision_routing_family" CHECK ("family" IN ('issues', 'pull_request')),
    CONSTRAINT "code_host_decision_routing_rules_array" CHECK (jsonb_typeof("rules") = 'array'),
    CONSTRAINT "code_host_decision_routing_otherwise_type" CHECK ("otherwise"->>'type' IN ('default_agent', 'skip'))
);
CREATE UNIQUE INDEX "code_host_decision_routing_orgId_provider_repoId_family_key" ON "code_host_decision_routing"("orgId", "provider", "repoId", "family");
CREATE INDEX "code_host_decision_routing_decisionId_idx" ON "code_host_decision_routing"("decisionId");
CREATE INDEX "code_host_decision_routing_evaluationAgentId_idx" ON "code_host_decision_routing"("evaluationAgentId");
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_evaluationAgentId_fkey" FOREIGN KEY ("evaluationAgentId") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_host_decision_routing" ADD CONSTRAINT "code_host_decision_routing_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
