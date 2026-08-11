-- The session -> owning run lookup the console's PR panel is built on
-- (webchat-side-panels.md §9, M5). `sessionId` was written for deep-linking only
-- and never searched, so no index existed; without one the lookup is a
-- sequential scan of every run in the deployment. Partial, because the column is
-- null for the whole window between dispatch and the session being created, and
-- those rows are never the target of this lookup.
CREATE INDEX IF NOT EXISTS "hook_run_org_session_idx"
  ON "hook_run" ("orgId", "sessionId")
  WHERE "sessionId" IS NOT NULL;
