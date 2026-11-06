-- What an agent's new rooms and group DMs start at; NULL keeps the platform default (Auto where the daemon reads it, else Mention).
CREATE TYPE "NewConversationMode" AS ENUM ('auto', 'mention', 'off');
ALTER TABLE "agent" ADD COLUMN "newConversationMode" "NewConversationMode";
