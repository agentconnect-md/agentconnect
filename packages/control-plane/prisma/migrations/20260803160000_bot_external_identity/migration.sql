-- Generic bot demux identity (integration-plugin-architecture.md D6/§11):
-- externalAppId/externalTenantId generalize (slackAppId, teamId), and
-- platformConfig is the display-only per-platform bag the legacy display columns
-- fold into once reads switch. Backfill keeps legacy NULL semantics: NULLs are
-- distinct in the composite unique, so pre-capture Slack rows and backfilled
-- tenantless rows (Feishu) are unaffected by the new fence — only NEW rows write
-- the '-' tenant sentinel that makes (platform, externalAppId) unique.

ALTER TABLE "bot" ADD COLUMN "externalAppId" TEXT;
ALTER TABLE "bot" ADD COLUMN "externalTenantId" TEXT;
ALTER TABLE "bot" ADD COLUMN "platformConfig" JSONB;

-- Slack: the demux pair copies over verbatim (NULLs stay NULL).
UPDATE "bot"
SET "externalAppId" = "slackAppId", "externalTenantId" = "teamId"
WHERE "platform" = 'slack';

-- Feishu: the app id is the (tenantless) demux identity; region + app id also go
-- to the display bag. Tenant stays NULL — these are legacy rows.
UPDATE "bot"
SET "externalAppId" = "feishuAppId",
    "platformConfig" = jsonb_strip_nulls(
      jsonb_build_object('feishuAppId', "feishuAppId", 'feishuRegion', "feishuRegion")
    )
WHERE "platform" = 'feishu'
  AND ("feishuAppId" IS NOT NULL OR "feishuRegion" IS NOT NULL);

-- Discord: display-only app id; no demux identity today.
UPDATE "bot"
SET "platformConfig" = jsonb_build_object('discordAppId', "discordAppId")
WHERE "platform" = 'discord'
  AND "discordAppId" IS NOT NULL;

CREATE UNIQUE INDEX "bot_platform_externalAppId_externalTenantId_key"
ON "bot"("platform", "externalAppId", "externalTenantId");
