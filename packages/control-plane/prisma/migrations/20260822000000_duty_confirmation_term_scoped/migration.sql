-- Scope the duty confirmation to the grant it actually proves.
--
-- `confirmedAt` was a bare timestamp: it recorded THAT a holder had reported the group, never
-- WHICH hold it reported. Any later state that merely looked the same inherited it — a lapsed
-- lease re-taken by the same member, an in-place composition rewrite that added agents, or a
-- digest still carrying the previous term. `term` is already the fencing token: every grant path
-- bumps it and renewal never does, so (holder, term) names the exact grant.
ALTER TABLE "duty_group" ADD COLUMN "confirmedTerm" BIGINT;
ALTER TABLE "duty_group" ADD COLUMN "confirmedHolder" UUID;

-- Carry the currently-true confirmations across rather than manufacturing a heartbeat-long gap in
-- ingress routing at deploy time: a row that is held AND was confirmed is being served right now,
-- and its current (holder, term) is what that confirmation was about.
UPDATE "duty_group"
SET "confirmedTerm" = "term", "confirmedHolder" = "holder"
WHERE "holder" IS NOT NULL AND "confirmedAt" IS NOT NULL;

-- The predicate is now a same-row comparison, which no index can serve; the read is driven by
-- `duty_group_member`'s primary key into `duty_group`'s.
DROP INDEX "duty_group_confirmedAt_idx";
ALTER TABLE "duty_group" DROP COLUMN "confirmedAt";
