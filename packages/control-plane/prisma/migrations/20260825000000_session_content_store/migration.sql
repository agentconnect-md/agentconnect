-- Session-scoped content provenance: WHICH store this session's transcript was written to.
--
-- `daemonId` names the daemon that first reported the session, and for a self-hosted daemon that
-- is also the only machine holding the rows. A cluster pool member is different: its store is the
-- install-wide data-plane Postgres its peers share. Pool members are bound to a Pod UID and reaped
-- 15 minutes after they go silent, and the FK SetNulls `daemonId` on every session they recorded —
-- so routing a content read by that column alone loses transcripts that are still fully present.
--
-- The agent's CURRENT placement cannot stand in for this: an agent can be moved into a set, out of
-- one, or between two long after a session ran, and failing a read over to a store that never held
-- it returns a valid-looking EMPTY page rather than an error. Null here ⇒ the recorder's own local
-- store, which nobody else can read.
--
-- IF NOT EXISTS / conditional constraint: an earlier attempt at this column (`session_content_set`,
-- reverted in #1020) may already have been applied to a database. `prisma migrate deploy` does not
-- replay a migration that is applied-but-missing locally, so this has to converge both states onto
-- the same shape rather than assume a clean one.
ALTER TABLE "session_meta" ADD COLUMN IF NOT EXISTS "contentSetId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_meta_contentSetId_fkey'
  ) THEN
    ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_contentSetId_fkey"
      FOREIGN KEY ("contentSetId") REFERENCES "member_set"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill (a), exact: the recorded daemon is still a member of a set, so the content it holds is
-- in that set's shared store. Nothing is inferred — the recorder itself is the evidence.
UPDATE "session_meta" s
SET "contentSetId" = m."setId"
FROM "member_set_member" m
JOIN "member_set" ms ON ms."id" = m."setId"
WHERE s."daemonId" = m."daemonId" AND ms."orgId" IS NULL AND s."contentSetId" IS NULL;

-- Backfill (b), INFERRED, and deliberately confined to this one-time recovery: rows a retired pool
-- member already SetNulled have no recorder left to ask, so placement is the only signal there is.
-- A `set`-placed agent on the org-less pool could normally only have recorded into that pool.
--
-- The inference is not airtight, and the exact hole is worth naming: a session that ran on a local
-- daemon, whose agent was then moved onto the pool, and whose original daemon was later removed
-- with `DELETE /daemons/:id`, reaches this UPDATE and is wrongly attributed to the pool. Its read
-- then returns an empty page instead of a 503. That costs a row which is already permanently
-- unreadable today, which is why it is worth the recovery — but it is the reason live routing
-- never makes this inference, and the reason a store-authoritative reconciliation (asking a member
-- which sessions it actually holds) is the right way to settle these rows for good.
UPDATE "session_meta" s
SET "contentSetId" = a."setId"
FROM "agent" a
JOIN "member_set" ms ON ms."id" = a."setId"
WHERE s."agentId" = a."id"
  AND s."daemonId" IS NULL
  AND s."contentSetId" IS NULL
  AND a."placementKind" = 'set'
  AND ms."orgId" IS NULL;

-- Everything else stays null: no evidence the content was ever written to a shared store.
