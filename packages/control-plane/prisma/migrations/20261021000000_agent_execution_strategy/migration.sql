-- The agent's execution strategy, per-strategy runtime catalogs, and a session's birth strategy on its executor hint (session-executors.md §5).
BEGIN;

ALTER TABLE "agent" ADD COLUMN "execution" TEXT;
ALTER TABLE "runtime_profile" ADD COLUMN "strategies" JSONB;
ALTER TABLE "session_executor_hint" ADD COLUMN "strategy" TEXT;

-- The one-time migration: unsandboxed is `host`, and a sandboxed agent with no placement is `srt`.
-- A sandboxed agent that is placed stays null until its daemon reports its legacy backend at registration.
-- `execution` rides the spec, and a daemon refuses an equal revision with a different digest, so each write bumps it.
UPDATE "agent" SET "execution" = 'host', "configRevision" = "configRevision" + 1 WHERE NOT "runInSandbox";
UPDATE "agent" SET "execution" = 'srt', "configRevision" = "configRevision" + 1
WHERE "runInSandbox" AND "daemonId" IS NULL AND "setId" IS NULL;

COMMIT;
