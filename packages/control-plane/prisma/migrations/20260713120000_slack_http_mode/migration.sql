-- slack-http-mode: signing secret, bot transport axis, drop per-bot relay
-- placement, durable shared-thread affinity.

-- BotSecret.signingSecret — Slack Events API request-verification key (http transport).
ALTER TABLE "bot_secret" ADD COLUMN "signingSecret" TEXT;

-- Bot.transport — socket|http ingress axis. Default socket (classic Socket Mode).
-- No backfill: existing bots stay socket; http is chosen explicitly at create time.
CREATE TYPE "SlackTransport" AS ENUM ('socket', 'http');
ALTER TABLE "bot" ADD COLUMN "transport" "SlackTransport" NOT NULL DEFAULT 'socket';

-- Whole-pool relay ingress: there is no per-bot relay placement anymore.
DROP INDEX IF EXISTS "bot_relayId_idx";
ALTER TABLE "bot" DROP COLUMN "relayId";

-- Durable per-sessionKey thread affinity for http-transport shared bots.
CREATE TABLE "shared_thread_agent" (
    "botId" UUID NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shared_thread_agent_pkey" PRIMARY KEY ("botId", "sessionKey")
);
CREATE INDEX "shared_thread_agent_botId_idx" ON "shared_thread_agent"("botId");
