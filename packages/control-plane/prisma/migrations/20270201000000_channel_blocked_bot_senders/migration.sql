-- Per conversation, the bot senders whose posts activate no agent there.
ALTER TABLE "integration_channel" ADD COLUMN "blockedBotSenders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A bot that posted in one of a bot's conversations: what the console names a blocked or blockable sender by.
CREATE TABLE "bot_channel_sender" (
    "botId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bot_channel_sender_pkey" PRIMARY KEY ("botId","channelId","senderId")
);

ALTER TABLE "bot_channel_sender" ADD CONSTRAINT "bot_channel_sender_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
