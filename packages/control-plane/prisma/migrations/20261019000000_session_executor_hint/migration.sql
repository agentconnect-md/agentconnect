-- Where a session key last ran, recorded from a relayed ready prepare as well as the session report (session-executors.md §7).
BEGIN;

CREATE TABLE "session_executor_hint" (
    "agentId" UUID NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "executorDaemonId" UUID,
    "observedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "session_executor_hint_pkey" PRIMARY KEY ("agentId", "sessionKey")
);
ALTER TABLE "session_executor_hint" ADD CONSTRAINT "session_executor_hint_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
