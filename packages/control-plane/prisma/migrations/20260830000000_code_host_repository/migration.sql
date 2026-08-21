-- Provider-qualified repository catalog + deployment-global claim
-- (docs/designs/gitlab-com-integration.md §8.1). Readers-first: this migration
-- creates the catalog and backfills GitHub numeric identities from the three
-- existing reference points; legacy columns remain the read path until writers
-- cut over, so behavior is unchanged.

CREATE TABLE "code_host_repository" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" BIGINT NOT NULL,
    "displayPath" TEXT NOT NULL,
    "cloneUrl" TEXT,
    "defaultBranch" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "code_host_repository_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_host_repository_orgId_provider_externalId_key" ON "code_host_repository"("orgId", "provider", "externalId");
CREATE INDEX "code_host_repository_orgId_idx" ON "code_host_repository"("orgId");

ALTER TABLE "code_host_repository" ADD CONSTRAINT "code_host_repository_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deployment-GLOBAL claim: one managing organization per external project.
-- Deliberately FK-free — the claim must survive owner deletion so external
-- cleanup debt is never silently orphaned. GitLab v1 only; the GitHub
-- installation claim stays where it is.
CREATE TABLE "code_host_repository_claim" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" BIGINT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bindingRef" UUID,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "code_host_repository_claim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_host_repository_claim_provider_externalId_key" ON "code_host_repository_claim"("provider", "externalId");
CREATE INDEX "code_host_repository_claim_orgId_idx" ON "code_host_repository_claim"("orgId");

-- Backfill: one catalog row per (org, github numeric id) referenced today.
-- Three sources; later sources keep the first row (ON CONFLICT DO NOTHING),
-- and the freshest display path wins only for rows this INSERT itself creates.
INSERT INTO "code_host_repository" ("id", "orgId", "provider", "externalId", "displayPath", "cloneUrl", "updatedAt")
SELECT gen_random_uuid(), src."orgId", 'github', src."repoId", src."fullName",
       'https://github.com/' || src."fullName", CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("orgId", "repoId") "orgId", "repoId", "fullName"
    FROM (
        SELECT a."orgId", a."workspaceRepoId" AS "repoId",
               regexp_replace(regexp_replace(a."gitRepo", '^(https?://)?github\.com/', ''), '\.git$', '') AS "fullName",
               a."updatedAt"
        FROM "agent" a
        WHERE a."workspaceRepoId" IS NOT NULL
          AND a."gitRepo" ~ '^(https?://)?github\.com/'
        UNION ALL
        SELECT ag."orgId", r."repoId", r."repoFullName", r."createdAt" AS "updatedAt"
        FROM "agent_repo_authorization" r
        JOIN "agent" ag ON ag."id" = r."agentId"
        UNION ALL
        SELECT h."orgId", h."repoId", h."repoFullName", h."updatedAt"
        FROM "hook_def" h
        WHERE h."kind" = 'github' AND h."repoId" IS NOT NULL AND h."repoFullName" IS NOT NULL
    ) refs
    WHERE refs."fullName" IS NOT NULL AND refs."fullName" <> ''
    ORDER BY "orgId", "repoId", "updatedAt" DESC
) src
ON CONFLICT ("orgId", "provider", "externalId") DO NOTHING;
