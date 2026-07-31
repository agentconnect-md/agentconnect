-- Current-session fence for remote webchat MCP authorization.
--
-- `session_meta.endedAt` cannot identify the currently installed ACP session:
-- the daemon stamps phase 'end' after EVERY turn and the milestone upsert never
-- clears it, so any `endedAt IS NULL` predicate fails after the first completed
-- turn. The conversation now carries an explicit pointer to its exact current
-- session, maintained transactionally by the milestone upsert under a lock on
-- the conversation row (which also serializes concurrent replacement inserts
-- against authorization reads locking the same row).
ALTER TABLE "webchat_conversation" ADD COLUMN "currentSessionId" TEXT;
ALTER TABLE "webchat_conversation" ADD COLUMN "currentSessionRev" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "webchat_conversation"
  ADD CONSTRAINT "webchat_conversation_currentSessionId_fkey"
  FOREIGN KEY ("currentSessionId") REFERENCES "session_meta"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "webchat_conversation_currentSessionId_idx"
  ON "webchat_conversation"("currentSessionId");

-- Backfill: point each conversation at its newest reported webchat session
-- (identity only — visibility is always evaluated live by the authorization
-- predicates). Conversations with no session rows stay NULL and fail closed
-- until the next milestone lands.
UPDATE "webchat_conversation" AS c
SET "currentSessionId" = s."id", "currentSessionRev" = 1
FROM (
  SELECT DISTINCT ON ("channel") "channel", "id", "agentId"
  FROM "session_meta"
  WHERE "platform" = 'webchat' AND "channel" IS NOT NULL
  ORDER BY "channel", "lastActivityAt" DESC, "startedAt" DESC, "id" DESC
) AS s
WHERE s."channel" = c."id"::text AND s."agentId" = c."agentId";
