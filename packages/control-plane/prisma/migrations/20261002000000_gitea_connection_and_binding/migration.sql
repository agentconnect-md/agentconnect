-- Gitea integration (gitea-integration.md §4, §5): the organization's bot connection, its sealed
-- token side-table, the managed repository bindings, and their sealed webhook signing keys.

CREATE TABLE "gitea_connection" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "botUserId" BIGINT NOT NULL,
    "botUsername" TEXT NOT NULL,
    "botDisplayName" TEXT,
    "credentialEpoch" BIGINT NOT NULL DEFAULT 1,
    "instanceVersion" TEXT,
    "state" TEXT NOT NULL,
    "lastVerifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitea_connection_pkey" PRIMARY KEY ("id")
);

-- Deployment-global: one bot user serves at most one connection (§4.1).
CREATE UNIQUE INDEX "gitea_connection_botUserId_key" ON "gitea_connection"("botUserId");
CREATE INDEX "gitea_connection_orgId_idx" ON "gitea_connection"("orgId");

ALTER TABLE "gitea_connection" ADD CONSTRAINT "gitea_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitea_connection" ADD CONSTRAINT "gitea_connection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sealed bot token: read only through the secret store, never joined by DTO queries.
CREATE TABLE "gitea_connection_secret" (
    "connectionId" UUID NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "gitea_connection_secret_pkey" PRIMARY KEY ("connectionId")
);

ALTER TABLE "gitea_connection_secret" ADD CONSTRAINT "gitea_connection_secret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "gitea_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitea_repository_binding" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" UUID NOT NULL,
    "repoId" BIGINT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "cloneUrl" TEXT,
    "defaultBranch" TEXT,
    "webhookId" BIGINT,
    "desiredEventsHash" TEXT,
    "lastVerifiedDeliveryAt" TIMESTAMPTZ(6),
    "convergeOwedAt" TIMESTAMPTZ(6),
    "state" TEXT NOT NULL,
    "stateReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitea_repository_binding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitea_repository_binding_orgId_repoId_key" ON "gitea_repository_binding"("orgId", "repoId");
CREATE INDEX "gitea_repository_binding_orgId_idx" ON "gitea_repository_binding"("orgId");
CREATE INDEX "gitea_repository_binding_connectionId_idx" ON "gitea_repository_binding"("connectionId");
CREATE INDEX "gitea_repository_binding_convergeOwedAt_idx" ON "gitea_repository_binding"("convergeOwedAt");

ALTER TABLE "gitea_repository_binding" ADD CONSTRAINT "gitea_repository_binding_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitea_repository_binding" ADD CONSTRAINT "gitea_repository_binding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "gitea_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitea_webhook_secret" (
    "bindingId" UUID NOT NULL,
    "signingKey" TEXT NOT NULL,
    "nextSigningKey" TEXT,

    CONSTRAINT "gitea_webhook_secret_pkey" PRIMARY KEY ("bindingId")
);

ALTER TABLE "gitea_webhook_secret" ADD CONSTRAINT "gitea_webhook_secret_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "gitea_repository_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- §6/§10.2: the deployment-global claim must survive the owning binding — including an
-- organization deletion that cascades the binding away — without losing the webhook id its
-- external cleanup still needs, and without ever releasing by time.
CREATE OR REPLACE FUNCTION gitea_binding_claim_guard() RETURNS trigger AS $$
BEGIN
    IF OLD."webhookId" IS NOT NULL THEN
        UPDATE "code_host_repository_claim"
           SET "bindingRef" = NULL,
               "state" = 'cleanup_pending',
               "tombstone" = jsonb_build_object(
                   'repoId', OLD."repoId"::text,
                   'repoPath', OLD."repoPath",
                   'webhookId', OLD."webhookId"::text
               )
         WHERE "provider" = 'gitea' AND "externalId" = OLD."repoId" AND "bindingRef" = OLD."id";
    ELSE
        -- No provider mutation ever began: the claim releases safely.
        DELETE FROM "code_host_repository_claim"
         WHERE "provider" = 'gitea' AND "externalId" = OLD."repoId" AND "bindingRef" = OLD."id";
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gitea_binding_claim_guard
BEFORE DELETE ON "gitea_repository_binding"
FOR EACH ROW EXECUTE FUNCTION gitea_binding_claim_guard();
