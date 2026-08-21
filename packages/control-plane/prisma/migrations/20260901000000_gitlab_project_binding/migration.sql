-- GitLab project bindings (gitlab-com-integration.md §8.2, §10): the org-scoped
-- managed-project row, purpose-separated credential metadata with sealed
-- side-tables, and the managed webhook's sealed signing key.

CREATE TABLE "gitlab_project_binding" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" BIGINT NOT NULL,
    "projectPath" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "installerConnectionId" UUID,
    "serviceAccountUserId" BIGINT,
    "serviceAccountUsername" TEXT,
    "webhookId" BIGINT,
    "desiredEventsHash" TEXT,
    "credentialEpoch" BIGINT NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "stateReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_project_binding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_project_binding_orgId_projectId_key" ON "gitlab_project_binding"("orgId", "projectId");
CREATE INDEX "gitlab_project_binding_orgId_idx" ON "gitlab_project_binding"("orgId");

ALTER TABLE "gitlab_project_binding" ADD CONSTRAINT "gitlab_project_binding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_project_binding" ADD CONSTRAINT "gitlab_project_binding_installerConnectionId_fkey" FOREIGN KEY ("installerConnectionId") REFERENCES "gitlab_connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "gitlab_project_credential" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "externalTokenId" BIGINT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "providerExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_project_credential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_project_credential_bindingId_purpose_key" ON "gitlab_project_credential"("bindingId", "purpose");

ALTER TABLE "gitlab_project_credential" ADD CONSTRAINT "gitlab_project_credential_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "gitlab_project_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitlab_project_credential_secret" (
    "credentialId" UUID NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "gitlab_project_credential_secret_pkey" PRIMARY KEY ("credentialId")
);

ALTER TABLE "gitlab_project_credential_secret" ADD CONSTRAINT "gitlab_project_credential_secret_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "gitlab_project_credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitlab_webhook_secret" (
    "bindingId" UUID NOT NULL,
    "signingKey" TEXT NOT NULL,

    CONSTRAINT "gitlab_webhook_secret_pkey" PRIMARY KEY ("bindingId")
);

ALTER TABLE "gitlab_webhook_secret" ADD CONSTRAINT "gitlab_webhook_secret_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "gitlab_project_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
