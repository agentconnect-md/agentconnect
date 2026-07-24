-- Self-introduce-on-join (issue #536): opt-in per agent. When true, on a genuine
-- new channel join the agent proactively introduces itself to the peers already
-- there so they can record it in memory. Default off.

ALTER TABLE "agent" ADD COLUMN "introduceOnJoin" BOOLEAN NOT NULL DEFAULT false;
