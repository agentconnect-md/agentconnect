-- Conversation grouping (merged-conversation-view.md §5.1/§5.2):
-- persist the durable workspace/tenant scope on session rows and index the
-- conversation key for the emit-at-max probe + member backfill/resolver.
ALTER TABLE "session_meta" ADD COLUMN "tenantScope" TEXT;

DROP INDEX "session_meta_platform_channel_idx";

CREATE INDEX "session_meta_conversation_key_idx" ON "session_meta"(
  "orgId" ASC, "platform" ASC, "tenantScope" ASC, "channel" ASC, "thread" ASC,
  "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
);
