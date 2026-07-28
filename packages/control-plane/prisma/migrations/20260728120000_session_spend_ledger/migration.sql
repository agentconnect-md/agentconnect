-- SessionSpend — append-only incremental spend ledger for the spend-over-time
-- chart. session_usage stays the latest-wins CUMULATIVE snapshot (per-agent and
-- token totals); this table records each usage/report's cost delta stamped at its
-- activity time, so the /usage series can attribute spend to the bucket it
-- actually happened in instead of collapsing a session's whole cost into its
-- newest bucket. Rows are only inserted, never updated.
CREATE TABLE "public"."session_spend" (
    "id" BIGSERIAL NOT NULL,
    "agentId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "costAmount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "session_spend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "session_spend_agentId_at_idx" ON "public"."session_spend"("agentId" ASC, "at" ASC);

ALTER TABLE "public"."session_spend" ADD CONSTRAINT "session_spend_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
