-- Platform-published (distributed) Slack app (docs/designs/preset-agents.md §5.3).
--
-- 1. `bot.teamId` — the Slack workspace id ("T…"). Load-bearing for relay demux:
--    every install of a distributed app shares one api_app_id AND one signing
--    secret, so only the composite (slackAppId, teamId) identifies the Bot. The
--    unique index keeps one Bot per workspace install; NULLs stay distinct, so
--    legacy rows (teamId NULL, possibly sharing a slackAppId) are unaffected.
-- 2. `bot.botUserId` — from the OAuth exchange; spares an auth.test round-trip.
-- 3. `bot.revokedAt` — stamped on `app_uninstalled` / `tokens_revoked`.
-- 4. `bot.credentialRevision` / `bot.credentialInstalledAt` — the install
--    GENERATION fence. Slack does not guarantee lifecycle-event ordering, so a
--    delayed `app_uninstalled` from a prior install can arrive after a
--    re-install; without a generation marker it would revoke the FRESH token.
--    Both advance together whenever a new credential lands on the bot.
-- 5. `slack_platform_install` — pending-install state rows binding the OAuth
--    `state` to {org, target agent, user}; per-app credentials stay in env.
--    `status`/`failureReason` make the row a completion SIGNAL the console can
--    poll (a re-authorization need not create an integration, so "a new
--    integration appeared" is not a usable success test).

-- AlterTable
ALTER TABLE "bot" ADD COLUMN "teamId" TEXT;
ALTER TABLE "bot" ADD COLUMN "botUserId" TEXT;
ALTER TABLE "bot" ADD COLUMN "revokedAt" TIMESTAMPTZ(6);
ALTER TABLE "bot" ADD COLUMN "credentialRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "bot" ADD COLUMN "credentialInstalledAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "bot_slackAppId_teamId_key" ON "bot"("slackAppId", "teamId");

-- CreateEnum
CREATE TYPE "SlackPlatformInstallStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "slack_platform_install" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "status" "SlackPlatformInstallStatus" NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "botId" UUID,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "slack_platform_install_pkey" PRIMARY KEY ("id")
);
