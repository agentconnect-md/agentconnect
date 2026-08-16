-- Ingress addressing must name a holder that is provably SERVING, not merely granted: a grant is
-- applied on the daemon only after its install succeeds (#972), so "the holder reported this group
-- in its digest" is the confirmation, and it is the same signal the self-fence and CP renewal
-- already ride. Null while a grant is outstanding.
ALTER TABLE "duty_group" ADD COLUMN "confirmedAt" TIMESTAMPTZ(6);

-- Every currently-held group IS being served right now, so assert it rather than manufacturing a
-- heartbeat-long gap in A2A routing at deploy time. `updatedAt` is the last time the lease moved,
-- which is the closest true statement available for rows that predate the column.
UPDATE "duty_group" SET "confirmedAt" = "updatedAt" WHERE "holder" IS NOT NULL;

-- The ingress read is "confirmed holders of this agent", so it scans by holder among confirmed rows.
CREATE INDEX "duty_group_confirmedAt_idx" ON "duty_group"("confirmedAt");
