-- Multi-agent webchat conversations (webchat-multi-agents.md §3.1): one row per
-- participant agent. The roster is fixed at creation; `webchat_conversation.agentId`
-- stays the compatibility mirror of the `role='primary'` row. Each participant
-- carries its own current-session pointer (the conversation-level pointer keeps
-- tracking the primary during migration).
CREATE TABLE "webchat_conversation_agent" (
  "conversationId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  "ord" INTEGER NOT NULL DEFAULT 0,
  "addedByUserId" TEXT NOT NULL,
  "addedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "currentSessionId" TEXT,
  "currentSessionRev" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "webchat_conversation_agent_pkey" PRIMARY KEY ("conversationId", "agentId")
);

CREATE INDEX "webchat_conversation_agent_agentId_idx" ON "webchat_conversation_agent"("agentId");
CREATE INDEX "webchat_conversation_agent_currentSessionId_idx" ON "webchat_conversation_agent"("currentSessionId");

ALTER TABLE "webchat_conversation_agent"
  ADD CONSTRAINT "webchat_conversation_agent_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "webchat_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_conversation_agent"
  ADD CONSTRAINT "webchat_conversation_agent_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_conversation_agent"
  ADD CONSTRAINT "webchat_conversation_agent_currentSessionId_fkey"
  FOREIGN KEY ("currentSessionId") REFERENCES "session_meta"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every existing conversation becomes a single-participant roster
-- whose primary row mirrors the conversation's binding and pointer.
INSERT INTO "webchat_conversation_agent" (
  "conversationId", "agentId", "role", "ord", "addedByUserId", "addedAt",
  "currentSessionId", "currentSessionRev"
)
SELECT c."id", c."agentId", 'primary', 0, c."userId", c."createdAt",
       c."currentSessionId", c."currentSessionRev"
FROM "webchat_conversation" AS c
ON CONFLICT ("conversationId", "agentId") DO NOTHING;
