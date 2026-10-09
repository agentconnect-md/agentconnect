-- Retire the agent's legacy `runInSandbox` boolean (#2463): `execution` is the only field (session-executors.md §5).
BEGIN;

-- The precondition says no agent is left unmigrated; a straggler takes the strategy the one-time migration would have given it.
-- `execution` rides the spec, and a daemon refuses an equal revision with a different digest, so each write bumps it.
UPDATE "agent" SET "execution" = 'srt', "configRevision" = "configRevision" + 1
WHERE "execution" IS NULL AND "runInSandbox";
UPDATE "agent" SET "execution" = 'host', "configRevision" = "configRevision" + 1
WHERE "execution" IS NULL;

ALTER TABLE "agent" ALTER COLUMN "execution" SET NOT NULL;
ALTER TABLE "agent" ALTER COLUMN "execution" SET DEFAULT 'host';
ALTER TABLE "agent" DROP COLUMN "runInSandbox";

COMMIT;
