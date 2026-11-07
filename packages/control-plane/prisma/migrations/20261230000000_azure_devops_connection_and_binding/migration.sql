-- Azure DevOps (azure-devops-integration.md §3-§5): connections, the identity table, bindings, and the connection columns.

ALTER TABLE "agent" ADD COLUMN "workspaceConnectionId" UUID;
ALTER TABLE "agent_repo_authorization" ADD COLUMN "connectionId" UUID;

CREATE TABLE "azure_devops_connection" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "tenantId" UUID NOT NULL,
    "organization" TEXT NOT NULL,
    "organizationInstanceId" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "identityName" TEXT,
    "credentialSource" TEXT NOT NULL,
    "clientId" UUID,
    "credentialEpoch" BIGINT NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "stateReason" TEXT,
    "lastVerifiedAt" TIMESTAMPTZ(6),
    "secretFingerprint" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "azure_devops_connection_pkey" PRIMARY KEY ("id")
);

-- An own application's sealed client secret: read only through the secret store, never joined by DTO queries.
CREATE TABLE "azure_devops_connection_secret" (
    "connectionId" UUID NOT NULL,
    "clientSecret" TEXT NOT NULL,

    CONSTRAINT "azure_devops_connection_secret_pkey" PRIMARY KEY ("connectionId")
);

-- Deployment-global and append-only (§4): a sequence never hands an id out twice.
CREATE TABLE "azure_devops_repository_identity" (
    "id" BIGSERIAL NOT NULL,
    "repositoryId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "organizationInstanceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "azure_devops_repository_identity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "azure_devops_repository_binding" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" UUID NOT NULL,
    "identityId" BIGINT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "cloneUrl" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "state" TEXT NOT NULL,
    "stateReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "azure_devops_repository_binding_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "azure_devops_connection_orgId_idx" ON "azure_devops_connection"("orgId");
CREATE INDEX "azure_devops_connection_organizationInstanceId_idx" ON "azure_devops_connection"("organizationInstanceId");
CREATE UNIQUE INDEX "azure_devops_connection_orgId_identityId_key" ON "azure_devops_connection"("orgId", "identityId");
CREATE UNIQUE INDEX "azure_devops_repository_identity_repositoryId_key" ON "azure_devops_repository_identity"("repositoryId");
CREATE INDEX "azure_devops_repository_binding_orgId_idx" ON "azure_devops_repository_binding"("orgId");
CREATE INDEX "azure_devops_repository_binding_identityId_idx" ON "azure_devops_repository_binding"("identityId");
CREATE UNIQUE INDEX "azure_devops_repository_binding_connectionId_identityId_key" ON "azure_devops_repository_binding"("connectionId", "identityId");
CREATE INDEX "agent_workspaceConnectionId_workspaceRepoId_idx" ON "agent"("workspaceConnectionId", "workspaceRepoId");
CREATE INDEX "agent_repo_authorization_connectionId_repoId_idx" ON "agent_repo_authorization"("connectionId", "repoId");

-- MATCH SIMPLE: a row whose connection column is NULL (every other host) is not checked; a referenced binding cannot be deleted.
ALTER TABLE "agent" ADD CONSTRAINT "agent_workspaceConnectionId_workspaceRepoId_fkey" FOREIGN KEY ("workspaceConnectionId", "workspaceRepoId") REFERENCES "azure_devops_repository_binding"("connectionId", "identityId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "agent_repo_authorization" ADD CONSTRAINT "agent_repo_authorization_connectionId_repoId_fkey" FOREIGN KEY ("connectionId", "repoId") REFERENCES "azure_devops_repository_binding"("connectionId", "identityId") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "azure_devops_connection" ADD CONSTRAINT "azure_devops_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "azure_devops_connection" ADD CONSTRAINT "azure_devops_connection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "azure_devops_connection_secret" ADD CONSTRAINT "azure_devops_connection_secret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "azure_devops_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "azure_devops_repository_binding" ADD CONSTRAINT "azure_devops_repository_binding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "azure_devops_repository_binding" ADD CONSTRAINT "azure_devops_repository_binding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "azure_devops_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "azure_devops_repository_binding" ADD CONSTRAINT "azure_devops_repository_binding_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "azure_devops_repository_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No webhook means no external cleanup: the last binding of the organization (an org deletion included) releases the claim.
CREATE OR REPLACE FUNCTION azure_devops_binding_claim_release() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "azure_devops_repository_binding"
         WHERE "orgId" = OLD."orgId" AND "identityId" = OLD."identityId"
    ) THEN
        DELETE FROM "code_host_repository_claim"
         WHERE "provider" = 'azure-devops' AND "externalId" = OLD."identityId" AND "orgId" = OLD."orgId";
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER azure_devops_binding_claim_release
AFTER DELETE ON "azure_devops_repository_binding"
FOR EACH ROW EXECUTE FUNCTION azure_devops_binding_claim_release();
