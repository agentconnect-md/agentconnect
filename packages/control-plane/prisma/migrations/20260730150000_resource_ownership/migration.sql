-- Separate effective resource ownership from immutable creation attribution.
ALTER TABLE "public"."agent" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."daemon" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."cron_def" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."mcp_provider" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "public"."skill_source" ADD COLUMN "ownerUserId" TEXT;

-- Preserve the creator as owner while they are still a member. For resources
-- whose creator already left (or was deleted), hand ownership to a deterministic
-- current organization owner. An already-orphaned organization leaves this
-- nullable; last-member/account-deletion semantics are intentionally separate.
UPDATE "public"."agent" AS resource
SET "ownerUserId" = COALESCE(
  CASE WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId" END,
  (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
);

UPDATE "public"."daemon" AS resource
SET "ownerUserId" = COALESCE(
  CASE WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId" END,
  (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
);

UPDATE "public"."cron_def" AS resource
SET "ownerUserId" = COALESCE(
  CASE WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId" END,
  (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
);

UPDATE "public"."mcp_provider" AS resource
SET "ownerUserId" = COALESCE(
  CASE WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId" END,
  (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
);

UPDATE "public"."skill_source" AS resource
SET "ownerUserId" = COALESCE(
  CASE WHEN EXISTS (
    SELECT 1 FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId"
      AND member."userId" = resource."createdByUserId"
  ) THEN resource."createdByUserId" END,
  (
    SELECT member."userId" FROM "public"."membership" AS member
    WHERE member."orgId" = resource."orgId" AND member."role" = 'owner'
    ORDER BY member."userId"
    LIMIT 1
  )
);

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
