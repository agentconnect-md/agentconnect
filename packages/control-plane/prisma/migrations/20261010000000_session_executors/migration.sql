-- Session executors (docs/designs/session-executors.md §6, §7, §10). Additive: every existing row keeps its meaning.
BEGIN;

-- Session environments live on the machine, from its heartbeat or a relayed prepare's liveCount; null until one is reported.
ALTER TABLE "daemon" ADD COLUMN "hostedSessions" INTEGER;

-- The group admin's consent to spread sessions across the set's members. Off until someone turns it on.
ALTER TABLE "member_set" ADD COLUMN "spreadSessions" BOOLEAN NOT NULL DEFAULT false;

-- The birth verdict a holder reports: the daemon executing the session, or the reason slug it stayed home.
ALTER TABLE "session_meta" ADD COLUMN "executorDaemonId" UUID;
ALTER TABLE "session_meta" ADD COLUMN "stayedHomeReason" TEXT;

COMMIT;
