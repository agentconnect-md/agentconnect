-- Which shared store a session's rows went to, as the recorder reported it (`capabilities.contentStore`).
--
-- `contentSetId` was stamped only for the org-less pool, whose members provably share one store. A
-- daemon group's members may run a `postgres` store too (#2188), but each machine chooses its own, so
-- the set alone proves nothing: two members share rows only when they report the same store id.
-- Existing rows stay null; the pool keeps answering for them as before.
ALTER TABLE "session_meta" ADD COLUMN "contentStoreId" UUID;
