-- Soft removal of a webchat conversation member (webchat-multi-agents.md §3.1a); null keeps every existing row in the roster.
ALTER TABLE "webchat_conversation_agent" ADD COLUMN "removedAt" TIMESTAMPTZ(6),
ADD COLUMN "removedByUserId" TEXT;
