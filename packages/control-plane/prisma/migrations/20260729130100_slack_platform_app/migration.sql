-- Platform-published (distributed) Slack app (docs/designs/preset-agents.md §5.3).
--
-- 1. `bot.teamId` — the Slack workspace id ("T…"). Load-bearing for relay demux:
--    every install of a distributed app shares one api_app_id AND one signing
--    secret, so only the composite (slackAppId, teamId) identifies the Bot. The
--    unique index keeps one Bot per workspace install; NULLs stay distinct, so
--    legacy rows (teamId NULL, possibly sharing a slackAppId) are unaffected.
-- 2. `bot.botUserId` — from the OAuth exchange; spares an auth.test round-trip.
-- 3. `bot.revokedAt` — stamped on `app_uninstalled` / `tokens_revoked`.
-- 4. `slack_platform_install` — pending-install state rows binding the OAuth
--    `state` to {org, target agent, user}; per-app credentials stay in env.

-- AlterTable
ALTER TABLE "bot" ADD COLUMN "teamId" TEXT;
ALTER TABLE "bot" ADD COLUMN "botUserId" TEXT;
ALTER TABLE "bot" ADD COLUMN "revokedAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "bot_slackAppId_teamId_key" ON "bot"("slackAppId", "teamId");

-- CreateTable
CREATE TABLE "slack_platform_install" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_platform_install_pkey" PRIMARY KEY ("id")
);
