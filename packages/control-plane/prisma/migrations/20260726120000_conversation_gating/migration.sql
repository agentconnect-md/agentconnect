-- Conversation gating (resource-visibility.md §14): the per-conversation trigger
-- gains an 'off' state, and integration_channel rows learn their conversation kind
-- (member channel vs DM). PG 12+ allows ADD VALUE inside a transaction as long as
-- the new value is not used in the same transaction (we only add it here).
ALTER TYPE "ChannelTrigger" ADD VALUE IF NOT EXISTS 'off' BEFORE 'mention';

CREATE TYPE "ConversationKind" AS ENUM ('channel', 'im');

ALTER TABLE "integration_channel"
  ADD COLUMN "kind" "ConversationKind" NOT NULL DEFAULT 'channel';
