-- Bind each browser webchat conversation to the authenticated human who
-- created it. This is control metadata only; transcripts remain daemon-local.
CREATE TABLE "webchat_conversation" (
  "id" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "agentId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webchat_conversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webchat_conversation_orgId_idx" ON "webchat_conversation"("orgId");
CREATE INDEX "webchat_conversation_agentId_idx" ON "webchat_conversation"("agentId");
CREATE INDEX "webchat_conversation_userId_idx" ON "webchat_conversation"("userId");

ALTER TABLE "webchat_conversation"
  ADD CONSTRAINT "webchat_conversation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_conversation"
  ADD CONSTRAINT "webchat_conversation_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webchat_conversation"
  ADD CONSTRAINT "webchat_conversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
