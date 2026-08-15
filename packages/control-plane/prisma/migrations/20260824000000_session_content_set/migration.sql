-- Session-scoped content provenance: WHICH store this session's transcript was written to.
-- `daemonId` names the daemon that first reported the session, but a member set's daemons share
-- one data-plane store, so a retired member's rows stay readable through a peer. That failover is
-- only sound when the session itself was written to that set's store — the agent's CURRENT
-- placement proves nothing, because an agent can be moved into (or between) sets long after a
-- session ran on a local daemon. Null ⇒ the recorded daemon's own local store; nobody else has it.
ALTER TABLE "session_meta" ADD COLUMN "contentSetId" UUID;

ALTER TABLE "session_meta" ADD CONSTRAINT "session_meta_contentSetId_fkey"
  FOREIGN KEY ("contentSetId") REFERENCES "member_set"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (a): the recorded daemon is currently a member of a set, so the content it holds lives
-- in that set's shared store.
UPDATE "session_meta" s
SET "contentSetId" = m."setId"
FROM "member_set_member" m
WHERE s."daemonId" = m."daemonId" AND s."contentSetId" IS NULL;

-- Backfill (b): `daemonId IS NULL` on a `set`-placed agent ⇒ that agent's set. The only writer of
-- that null is the FK when a daemon row is deleted, and the only daemons deleted out from under
-- live sessions are org-less pool members retired by the pool-member reaper — which are by
-- definition members of the set the agent is placed on. A machine-placed agent keeps its recorded
-- daemon, so it is untouched here and stays null.
UPDATE "session_meta" s
SET "contentSetId" = a."setId"
FROM "agent" a
WHERE s."agentId" = a.id
  AND s."daemonId" IS NULL
  AND s."contentSetId" IS NULL
  AND a."placementKind" = 'set'
  AND a."setId" IS NOT NULL;

-- Everything else stays null: no evidence the content was ever written to a shared store.
