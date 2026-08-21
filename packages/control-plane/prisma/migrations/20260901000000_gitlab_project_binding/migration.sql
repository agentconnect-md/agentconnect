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

-- §10.2/§19.4: the deployment-global claim must survive the owning binding —
-- including an organization deletion that cascades the binding away — without
-- permanently locking the project or losing the external cleanup facts.
ALTER TABLE "code_host_repository_claim" ADD COLUMN "tombstone" JSONB;

CREATE OR REPLACE FUNCTION gitlab_binding_claim_guard() RETURNS trigger AS $$
DECLARE
    mutated boolean;
    token_ids bigint[];
BEGIN
    SELECT array_agg("externalTokenId") INTO token_ids
      FROM "gitlab_project_credential" WHERE "bindingId" = OLD."id";
    mutated := OLD."serviceAccountUserId" IS NOT NULL
        OR OLD."webhookId" IS NOT NULL
        OR token_ids IS NOT NULL;
    IF mutated THEN
        -- Provider state exists: keep the claim, detach it, and preserve the
        -- metadata-only cleanup facts an administrator (or a later takeover)
        -- needs to retire the external resources. Never released by time.
        UPDATE "code_host_repository_claim"
           SET "bindingRef" = NULL,
               "state" = 'cleanup_pending',
               "tombstone" = jsonb_build_object(
                   'projectId', OLD."projectId"::text,
                   'projectPath', OLD."projectPath",
                   'serviceAccountUserId', OLD."serviceAccountUserId"::text,
                   'webhookId', OLD."webhookId"::text,
                   'externalTokenIds', to_jsonb(COALESCE(token_ids, ARRAY[]::bigint[]))
               )
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    ELSE
        -- No provider mutation ever began (§10.2): the claim releases safely.
        DELETE FROM "code_host_repository_claim"
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gitlab_binding_claim_guard
BEFORE DELETE ON "gitlab_project_binding"
FOR EACH ROW EXECUTE FUNCTION gitlab_binding_claim_guard();
