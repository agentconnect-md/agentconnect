-- SessionSpend — spend timeline behind every range-scoped cost rollup (the
-- spend-over-time chart AND the Total-spend / per-agent cards). session_usage
-- stays the latest-wins lifetime snapshot (tokens, session counts, current cost);
-- this table records each usage/report's CUMULATIVE cost stamped at its activity
-- time, and readers derive window/bucket spend by diffing consecutive cumulatives.
-- Storing cumulative keyed by (agentId, sessionId, at) makes the write a plain
-- idempotent upsert, so replays, out-of-order, and concurrent duplicate reports
-- never double-count.
CREATE TABLE "public"."session_spend" (
    "agentId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "cumulativeCost" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "session_spend_pkey" PRIMARY KEY ("agentId","sessionId","at")
);

CREATE INDEX "session_spend_agentId_at_idx" ON "public"."session_spend"("agentId" ASC, "at" ASC);

ALTER TABLE "public"."session_spend" ADD CONSTRAINT "session_spend_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
