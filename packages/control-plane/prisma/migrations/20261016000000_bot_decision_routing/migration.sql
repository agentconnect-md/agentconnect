-- The shared-bot By decision router (decisions.md §6.2) and the relaxed channel CHECKs that let a row bind to it.
BEGIN;

CREATE TABLE "bot_decision_routing" (
    "botId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "decisionId" UUID NOT NULL,
    "rules" JSONB NOT NULL,
    "otherwise" JSONB NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "bot_decision_routing_pkey" PRIMARY KEY ("botId"),
    CONSTRAINT "bot_decision_routing_rules_array" CHECK (jsonb_typeof("rules") = 'array'),
    CONSTRAINT "bot_decision_routing_otherwise_type" CHECK ("otherwise"->>'type' IN ('default_agent', 'skip'))
);
CREATE INDEX "bot_decision_routing_orgId_idx" ON "bot_decision_routing"("orgId");
CREATE INDEX "bot_decision_routing_decisionId_idx" ON "bot_decision_routing"("decisionId");
ALTER TABLE "bot_decision_routing" ADD CONSTRAINT "bot_decision_routing_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_decision_routing" ADD CONSTRAINT "bot_decision_routing_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bot_decision_routing" ADD CONSTRAINT "bot_decision_routing_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bot_decision_routing" ADD CONSTRAINT "bot_decision_routing_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A router binding references the bot's record, so it carries no denormalized Decision id.
ALTER TABLE "integration_channel" DROP CONSTRAINT "integration_channel_decision_gate_ref";
ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decision_gate_ref"
  CHECK (
    ("decisionBinding" IS NULL AND "decisionId" IS NULL)
    OR ("decisionBinding"->>'type' = 'gate' AND "decisionId" IS NOT NULL AND "decisionBinding"->>'decisionId' = "decisionId"::text)
    OR ("decisionBinding" = '{"type":"shared_bot_routing"}'::jsonb AND "decisionId" IS NULL)
  );

-- A router's review state lives on the bot record, so only a gate row may be flagged.
ALTER TABLE "integration_channel" DROP CONSTRAINT "integration_channel_decision_review_bound";
ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decision_review_bound"
  CHECK (NOT "decisionNeedsReview" OR "decisionBinding"->>'type' = 'gate');

COMMIT;
