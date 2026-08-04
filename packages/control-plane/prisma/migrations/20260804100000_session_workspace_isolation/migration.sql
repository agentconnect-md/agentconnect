-- Persist the daemon-reported checkout choice so Session and Workspace views can
-- link to an isolated worktree without assuming the Agent's current preference.
ALTER TABLE "session_meta"
ADD COLUMN "workspaceIsolation" "WorkspaceIsolation";
