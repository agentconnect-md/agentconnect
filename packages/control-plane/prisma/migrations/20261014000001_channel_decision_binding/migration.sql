-- The By decision gate binding on a conversation row (decisions.md §6.2); additive, every existing row stays unbound.
BEGIN;

ALTER TABLE "integration_channel"
  ADD COLUMN "decisionBinding" JSONB,
  ADD COLUMN "decisionId" UUID,
  ADD COLUMN "decisionNeedsReview" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "integration_channel_decisionId_idx" ON "integration_channel"("decisionId");

ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decision_trigger_binding"
  CHECK (("trigger" = 'decision') = ("decisionBinding" IS NOT NULL));

-- Stage 2 relaxes this for shared_bot_routing bindings, which reference a bot-owned record instead.
ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decision_gate_ref"
  CHECK (
    ("decisionBinding" IS NULL AND "decisionId" IS NULL)
    OR ("decisionBinding"->>'type' = 'gate' AND "decisionId" IS NOT NULL AND "decisionBinding"->>'decisionId' = "decisionId"::text)
  );

ALTER TABLE "integration_channel" ADD CONSTRAINT "integration_channel_decision_review_bound"
  CHECK (NOT "decisionNeedsReview" OR "decisionBinding" IS NOT NULL);

COMMIT;
