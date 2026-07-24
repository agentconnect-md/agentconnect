-- OS sandbox per agent (issue #642): confine the agent process to its agent
-- directory (workspace + clones + memory) via bwrap / sandbox-exec. Default on;
-- a daemon without a sandbox mechanism runs the agent unconfined (fail-open).

ALTER TABLE "agent" ADD COLUMN "restrictFileAccess" BOOLEAN NOT NULL DEFAULT true;
