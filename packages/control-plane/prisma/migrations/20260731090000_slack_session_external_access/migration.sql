-- Slack shared-session access. A Session keeps an immutable reference to its
-- source conversation while current membership remains provider-owned and is
-- resolved only on reads.

ALTER TYPE "SessionVisibility" ADD VALUE IF NOT EXISTS 'external';

CREATE TYPE "ExternalResolution" AS ENUM ('pending', 'settled', 'invalid');
CREATE TYPE "ExternalAccessPolicyState" AS ENUM ('disabled', 'enabling', 'enabled', 'degraded');

CREATE TABLE "external_scope" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "orgId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "realmKey" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "resourceKey" TEXT NOT NULL,
  "credentialKind" TEXT,
  "credentialId" TEXT,
  "aclRevision" BIGINT NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "external_scope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_scope_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "external_scope_id_orgId_provider_key"
  ON "external_scope"("id", "orgId", "provider");
CREATE UNIQUE INDEX "external_scope_orgId_provider_realmKey_resourceKind_resourceKey_key"
  ON "external_scope"("orgId", "provider", "realmKey", "resourceKind", "resourceKey");
CREATE INDEX "external_scope_credentialKind_credentialId_idx"
  ON "external_scope"("credentialKind", "credentialId");

CREATE TABLE "session_external_access_policy" (
  "orgId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "state" "ExternalAccessPolicyState" NOT NULL DEFAULT 'disabled',
  "currentRev" BIGINT NOT NULL DEFAULT 0,
  "readFenceRev" BIGINT,
  "migrationCursor" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "session_external_access_policy_pkey" PRIMARY KEY ("orgId", "provider"),
  CONSTRAINT "session_external_access_policy_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "session_meta"
  ADD COLUMN "externalProvider" TEXT,
  ADD COLUMN "externalScopeId" UUID,
  ADD COLUMN "externalResolution" "ExternalResolution",
  ADD COLUMN "classifiedPolicyRev" BIGINT;

ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_external_scope_fkey"
  FOREIGN KEY ("externalScopeId", "orgId", "externalProvider")
  REFERENCES "external_scope"("id", "orgId", "provider")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_external_shape_check" CHECK (
  (
    "externalProvider" IS NULL
    AND "externalScopeId" IS NULL
    AND "externalResolution" IS NULL
    AND "classifiedPolicyRev" IS NULL
    AND "visibility" <> 'external'::"SessionVisibility"
  )
  OR
  (
    "externalProvider" IS NOT NULL
    AND "externalResolution" IS NOT NULL
    AND "classifiedPolicyRev" IS NOT NULL
    AND "visibility" <> 'private'::"SessionVisibility"
    AND ("externalResolution" <> 'settled'::"ExternalResolution" OR "externalScopeId" IS NOT NULL)
  )
);

CREATE INDEX "session_meta_orgId_externalProvider_externalScopeId_idx"
  ON "session_meta"("orgId", "externalProvider", "externalScopeId");

-- A missing policy is fail-closed, so seed a durable disabled row before
-- marking legacy candidates. Slack DM ids are the only historical shape we can
-- exclude with trusted platform semantics; every other Slack-shaped row is
-- conservatively a shared candidate. Unknown historical scopes remain pending
-- and will be hidden once the owner enables the read fence.
INSERT INTO "session_external_access_policy" (
  "orgId", "provider", "state", "currentRev", "createdAt", "updatedAt"
)
WITH RECURSIVE candidates AS (
  SELECT "id"
  FROM "session_meta"
  WHERE ("platform" = 'slack' OR "platform" IS NULL)
    AND "channel" IS NOT NULL
    AND "channel" NOT LIKE 'D%'
  UNION
  SELECT child."id"
  FROM "session_meta" child
  JOIN candidates parent ON child."parentSessionId" = parent."id"
)
SELECT DISTINCT s."orgId", 'slack', 'disabled'::"ExternalAccessPolicyState", 0,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "session_meta" s
JOIN candidates c ON c."id" = s."id"
ON CONFLICT ("orgId", "provider") DO NOTHING;

WITH RECURSIVE candidates AS (
  SELECT "id"
  FROM "session_meta"
  WHERE ("platform" = 'slack' OR "platform" IS NULL)
    AND "channel" IS NOT NULL
    AND "channel" NOT LIKE 'D%'
  UNION
  SELECT child."id"
  FROM "session_meta" child
  JOIN candidates parent ON child."parentSessionId" = parent."id"
)
UPDATE "session_meta" s
SET "externalProvider" = 'slack',
    "externalResolution" = CASE
      WHEN s."visibility" = 'private'::"SessionVisibility"
        THEN 'invalid'::"ExternalResolution"
      ELSE 'pending'::"ExternalResolution"
    END,
    "visibility" = CASE
      WHEN s."visibility" = 'private'::"SessionVisibility"
        THEN 'external'::"SessionVisibility"
      ELSE s."visibility"
    END,
    "classifiedPolicyRev" = 0,
    -- Every candidate changes its daemon-side shared-memory verdict, including
    -- an org-visible row while sync is disabled. Bump unconditionally so the
    -- post-maintenance register replay cannot mistake an old org ACK for the
    -- new external isolation gate.
    "visibilityRev" = s."visibilityRev" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
FROM candidates c
WHERE s."id" = c."id"
  AND s."externalProvider" IS NULL;
