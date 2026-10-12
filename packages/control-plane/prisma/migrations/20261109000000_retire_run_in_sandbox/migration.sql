-- Retire the agent's legacy `runInSandbox` boolean (#2463): `execution` is the only field (session-executors.md §5).
BEGIN;

-- The precondition says no agent is left unmigrated; a straggler takes the strategy the one-time migration would have given it.
-- Every row's revision moves, not only the stragglers': dropping `runInSandbox` changes the content of every emitted spec, and a
-- daemon refuses an equal revision whose digest differs from the one it recorded, so an unbumped agent would be stuck until its next edit.
UPDATE "agent" SET
  "execution" = CASE
    WHEN "execution" IS NOT NULL THEN "execution"
    WHEN "runInSandbox" THEN 'srt'
    ELSE 'host'
  END,
  "configRevision" = "configRevision" + 1;

ALTER TABLE "agent" ALTER COLUMN "execution" SET NOT NULL;
ALTER TABLE "agent" ALTER COLUMN "execution" SET DEFAULT 'host';
ALTER TABLE "agent" DROP COLUMN "runInSandbox";

COMMIT;
