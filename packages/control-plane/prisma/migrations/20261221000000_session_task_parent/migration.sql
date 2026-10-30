-- The session that owns a session as a task now (auto-session-mode.md §6.2): it locks the task's visibility and lists it among the owner's related sessions.
ALTER TABLE "session_meta" ADD COLUMN "taskParentSessionId" TEXT;

CREATE INDEX "session_meta_taskParentSessionId_idx" ON "session_meta"("taskParentSessionId");
