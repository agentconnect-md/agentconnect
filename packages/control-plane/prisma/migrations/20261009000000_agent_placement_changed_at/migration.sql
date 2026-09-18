-- When an agent's placement last changed, for the pool's orphan reconciler
-- (docs/designs/k8s-daemon-pool.md §4).
--
-- A scheduled sweep cannot date a departure from anything it can observe. The claim's admission
-- stamp says when a member last USED it, which for a pod suspended before the move is long before
-- it; and a stamp the sweep writes itself cannot see a round trip that happened entirely between
-- two of its ten-minute runs, so a second move would inherit the first one's spent window. Only the
-- control plane knows, so it is the control plane that records it.
--
-- `settlePlacementChange` writes it, in the same transaction as the placement columns and only when
-- the placement actually moved — re-writing the same target is not a change.
--
-- Existing rows default to the migration's own clock rather than to their last placement, which is
-- not recorded anywhere to recover: every agent already off the pool therefore gets one full window
-- from here, which delays a reclaim by that window and can never shorten one.
BEGIN;

ALTER TABLE "agent"
  ADD COLUMN "placementChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

COMMIT;
