-- Separate effective resource ownership from immutable creation attribution.
BEGIN;

ALTER TABLE "public"."agent" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."daemon" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."cron_def" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."mcp_provider" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."skill_source" ADD COLUMN "ownerUserId" TEXT;

-- Preserve the creator as owner while they are still a member. If a recorded
-- creator left before this migration, apply the same transfer-to-org-owner rule
-- as member removal. A NULL creator is genuinely ownerless/system-created and
-- must stay ownerless; migration must not silently claim it.
UPDATE "public"."agent" AS resource
SET "ownerUserId" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId"
  WHEN resource."createdByUserId" IS NOT NULL THEN (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
END;

UPDATE "public"."daemon" AS resource
SET "ownerUserId" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId"
  WHEN resource."createdByUserId" IS NOT NULL THEN (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
END;

UPDATE "public"."cron_def" AS resource
SET "ownerUserId" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId"
  WHEN resource."createdByUserId" IS NOT NULL THEN (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
END;

UPDATE "public"."mcp_provider" AS resource
SET "ownerUserId" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId"
  WHEN resource."createdByUserId" IS NOT NULL THEN (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
END;

UPDATE "public"."skill_source" AS resource
SET "ownerUserId" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId"
  WHEN resource."createdByUserId" IS NOT NULL THEN (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
END;

CREATE INDEX "agent_orgId_ownerUserId_idx" ON "public"."agent"("orgId", "ownerUserId");
CREATE INDEX "daemon_orgId_ownerUserId_idx" ON "public"."daemon"("orgId", "ownerUserId");
CREATE INDEX "cron_def_orgId_ownerUserId_idx" ON "public"."cron_def"("orgId", "ownerUserId");
CREATE INDEX "mcp_provider_orgId_ownerUserId_idx" ON "public"."mcp_provider"("orgId", "ownerUserId");
CREATE INDEX "skill_source_orgId_ownerUserId_idx" ON "public"."skill_source"("orgId", "ownerUserId");

ALTER TABLE "public"."agent"
  ADD CONSTRAINT "agent_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."daemon"
  ADD CONSTRAINT "daemon_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."cron_def"
  ADD CONSTRAINT "cron_def_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."mcp_provider"
  ADD CONSTRAINT "mcp_provider_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."skill_source"
  ADD CONSTRAINT "skill_source_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
