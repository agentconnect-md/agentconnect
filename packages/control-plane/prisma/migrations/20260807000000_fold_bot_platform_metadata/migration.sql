-- Retire the duplicated bot demux fence, fold per-platform bot metadata into the
-- generic bag, and drop a dead cursor.
--
-- Order matters: every backfill runs BEFORE the constraint or column it makes
-- redundant is removed, so no row loses a fence or a value part-way through.

-- ---------------------------------------------------------------------------
-- 1. Give every fenced row a generic identity BEFORE the per-platform fence goes.
--
-- Rows written before the D6 dual-write landed carry (slackAppId, teamId) alone.
-- Dropping `bot_slackAppId_teamId_key` while they have a NULL generic identity
-- would leave them unfenced — and unfenced here means a second organization can
-- claim a workspace this one already holds.
--
-- Safe against the composite unique this populates: the index being dropped
-- below already guaranteed (slackAppId, teamId) is unique, and NULL teamIds stay
-- NULL, which Postgres keeps distinct in both indexes alike.
UPDATE "public"."bot"
SET "externalAppId" = "slackAppId",
    "externalTenantId" = "teamId"
WHERE "platform" = 'slack'
  AND "slackAppId" IS NOT NULL
  AND "externalAppId" IS NULL;

-- 2. The per-platform fence is now redundant with
--    bot_platform_externalAppId_externalTenantId_key, which carries the same
--    values for Slack (its projector mirrors the pair verbatim).
DROP INDEX IF EXISTS "public"."bot_slackAppId_teamId_key";

-- ---------------------------------------------------------------------------
-- 3. Fold the per-platform metadata columns into the generic bag.
--
-- `jsonb_strip_nulls` keeps an absent value absent rather than storing an
-- explicit null, so a read of the bag cannot tell "unset" from "set to null" —
-- the same distinction the nullable columns carried. Concatenating onto the
-- existing bag preserves anything a provider already wrote there.
UPDATE "public"."bot"
SET "platformConfig" = COALESCE("platformConfig", '{}'::jsonb) || jsonb_strip_nulls(
      jsonb_build_object(
        'discordAppId', "discordAppId",
        'feishuAppId', "feishuAppId",
        'feishuRegion', "feishuRegion"
      )
    )
WHERE "discordAppId" IS NOT NULL
   OR "feishuAppId" IS NOT NULL
   OR "feishuRegion" IS NOT NULL;

ALTER TABLE "public"."bot" DROP COLUMN "discordAppId";
ALTER TABLE "public"."bot" DROP COLUMN "feishuAppId";
ALTER TABLE "public"."bot" DROP COLUMN "feishuRegion";

-- ---------------------------------------------------------------------------
-- 4. The resume cursor for the one-time external-access classification pass.
--    Nothing has written it since that pass; every row carries NULL.
ALTER TABLE "public"."session_external_access_policy" DROP COLUMN "migrationCursor";
