-- Durable multi-agent participant membership for HTTP relay conversations.
-- This is routing metadata only; message content remains daemon-local.
CREATE TABLE "public"."shared_thread_participant" (
    "botId" UUID NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shared_thread_participant_pkey" PRIMARY KEY ("botId", "sessionKey", "agentId")
);

CREATE INDEX "shared_thread_participant_botId_idx"
    ON "public"."shared_thread_participant"("botId" ASC);

-- Every legacy affinity owner is already a participant in its conversation.
INSERT INTO "public"."shared_thread_participant" ("botId", "sessionKey", "agentId", "daemonId", "updatedAt")
SELECT "botId", "sessionKey", "agentId", "daemonId", "updatedAt"
FROM "public"."shared_thread_agent"
ON CONFLICT DO NOTHING;
