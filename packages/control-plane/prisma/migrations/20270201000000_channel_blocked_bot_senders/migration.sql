-- Per conversation, the bot senders whose posts activate no agent there.
ALTER TABLE "integration_channel" ADD COLUMN "blockedBotSenders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
