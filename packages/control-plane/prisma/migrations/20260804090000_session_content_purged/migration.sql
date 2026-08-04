-- Retention-GC receipt (#485, `event/session-purged`): the owning daemon deleted
-- the session's local row and any per-session worktree after `sessions.retention`
-- elapsed, so its transcript can never be pulled again. The CP keeps the metadata
-- row — it is all that remains of the session — and marks it purged so the console
-- explains the gap instead of rendering an empty transcript as "no messages".
--
-- Nullable with no backfill: rows purged before this migration existed cannot be
-- distinguished from live ones (the receipt was never sent), and a daemon whose
-- outbox still holds them re-reports on its next sweep.

ALTER TABLE "session_meta" ADD COLUMN "contentPurgedAt" TIMESTAMPTZ(6);
ALTER TABLE "session_meta" ADD COLUMN "contentPurgedReason" TEXT;
