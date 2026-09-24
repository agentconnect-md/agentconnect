-- Installation grants (docs/designs/agent-multi-repo-authorization.md decision 10): one additive table, GitHub-only and never `always`.
BEGIN;

CREATE TABLE "agent_installation_authorization" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "access" "RepoAccess" NOT NULL,
    "materialize" "RepoMaterialization" NOT NULL DEFAULT 'on-demand',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_installation_authorization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_installation_authorization_provider" CHECK ("provider" = 'github'),
    CONSTRAINT "agent_installation_authorization_materialize" CHECK ("materialize" <> 'always')
);
CREATE UNIQUE INDEX "agent_installation_authorization_installation_key" ON "agent_installation_authorization"("agentId", "provider", "installationId");
CREATE INDEX "agent_installation_authorization_agentId_idx" ON "agent_installation_authorization"("agentId");
ALTER TABLE "agent_installation_authorization" ADD CONSTRAINT "agent_installation_authorization_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_installation_authorization" ADD CONSTRAINT "agent_installation_authorization_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
