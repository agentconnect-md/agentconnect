-- Per-agent GitLab runtime identity (gitlab-com-integration.md §7.2, §8.2).
-- One group service account per (organization, agent, top-level group) replaces
-- the per-project account outright. Nothing is carried forward: the binding's
-- account columns are dropped and the credential table is re-keyed to the
-- issuing account, so every existing binding reconverges exactly like a binding
-- whose account is missing — its hooks and grants stay disabled until `ready`.
-- The per-project accounts left behind on GitLab are orphans an operator removes.

DROP TABLE "gitlab_project_credential_secret";
DROP TABLE "gitlab_project_credential";

ALTER TABLE "gitlab_project_binding"
  DROP COLUMN "serviceAccountUserId",
  DROP COLUMN "serviceAccountUsername";

CREATE TABLE "gitlab_agent_account" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "rootGroupId" BIGINT NOT NULL,
    "serviceAccountUserId" BIGINT,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "credentialEpoch" BIGINT NOT NULL DEFAULT 1,
    "administeringConnectionId" UUID,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(6),
    "generation" BIGINT NOT NULL DEFAULT 1,
    "lifecycle" TEXT NOT NULL DEFAULT 'active',
    "state" TEXT NOT NULL,
    "stateReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_agent_account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_agent_account_orgId_agentId_rootGroupId_key" ON "gitlab_agent_account"("orgId", "agentId", "rootGroupId");
CREATE INDEX "gitlab_agent_account_orgId_idx" ON "gitlab_agent_account"("orgId");
CREATE INDEX "gitlab_agent_account_agentId_idx" ON "gitlab_agent_account"("agentId");

-- The agent reference is deliberately unlinked: an account whose external
-- cleanup is still owed must outlive the agent that earned it (§19.4).
ALTER TABLE "gitlab_agent_account" ADD CONSTRAINT "gitlab_agent_account_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_agent_account" ADD CONSTRAINT "gitlab_agent_account_administeringConnectionId_fkey" FOREIGN KEY ("administeringConnectionId") REFERENCES "gitlab_connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "gitlab_account_membership" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "accountGeneration" BIGINT NOT NULL,
    "bindingId" UUID NOT NULL,
    "accessLevel" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_account_membership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_account_membership_accountId_bindingId_key" ON "gitlab_account_membership"("accountId", "bindingId");
CREATE INDEX "gitlab_account_membership_bindingId_idx" ON "gitlab_account_membership"("bindingId");

ALTER TABLE "gitlab_account_membership" ADD CONSTRAINT "gitlab_account_membership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "gitlab_agent_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gitlab_account_membership" ADD CONSTRAINT "gitlab_account_membership_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "gitlab_project_binding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitlab_project_credential" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "externalTokenId" BIGINT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "providerExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "gitlab_project_credential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gitlab_project_credential_accountId_purpose_key" ON "gitlab_project_credential"("accountId", "purpose");

ALTER TABLE "gitlab_project_credential" ADD CONSTRAINT "gitlab_project_credential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "gitlab_agent_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "gitlab_project_credential_secret" (
    "credentialId" UUID NOT NULL,
    "token" TEXT NOT NULL,

    CONSTRAINT "gitlab_project_credential_secret_pkey" PRIMARY KEY ("credentialId")
);

ALTER TABLE "gitlab_project_credential_secret" ADD CONSTRAINT "gitlab_project_credential_secret_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "gitlab_project_credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The claim guard reads identity through the new shape: the binding's own
-- account columns are gone, and the tokens that prove provider mutation now
-- hang off the accounts bound to this project. The claim state stays the
-- primary evidence — the saga flips it before its first provider write.
CREATE OR REPLACE FUNCTION gitlab_binding_claim_guard() RETURNS trigger AS $$
DECLARE
    claim_state text;
    account_ids bigint[];
    token_ids bigint[];
    mutated boolean;
BEGIN
    SELECT "state" INTO claim_state
      FROM "code_host_repository_claim"
     WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    IF claim_state IS NULL THEN
        RETURN OLD;
    END IF;
    SELECT array_agg(a."serviceAccountUserId") INTO account_ids
      FROM "gitlab_agent_account" a
      JOIN "gitlab_account_membership" m ON m."accountId" = a."id"
     WHERE m."bindingId" = OLD."id" AND a."serviceAccountUserId" IS NOT NULL;
    SELECT array_agg(c."externalTokenId") INTO token_ids
      FROM "gitlab_project_credential" c
      JOIN "gitlab_account_membership" m ON m."accountId" = c."accountId"
     WHERE m."bindingId" = OLD."id";
    mutated := claim_state <> 'provisioning'
        OR OLD."webhookId" IS NOT NULL
        OR account_ids IS NOT NULL
        OR token_ids IS NOT NULL;
    IF mutated THEN
        UPDATE "code_host_repository_claim"
           SET "bindingRef" = NULL,
               "state" = 'cleanup_pending',
               "tombstone" = jsonb_build_object(
                   'projectId', OLD."projectId"::text,
                   'projectPath', OLD."projectPath",
                   'serviceAccountUserIds', to_jsonb(COALESCE(account_ids, ARRAY[]::bigint[])),
                   'webhookId', OLD."webhookId"::text,
                   'externalTokenIds', to_jsonb(COALESCE(token_ids, ARRAY[]::bigint[]))
               )
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    ELSE
        DELETE FROM "code_host_repository_claim"
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
