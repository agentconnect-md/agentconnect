-- A cluster daemon upgrade writes its new image to the settings row and lets the
-- envelope re-apply pass push it, so a refused apply leaves a change that is still
-- coming. Undoing it needs two facts that only the request held: which image it asked
-- for, and which one to restore. Persisting them on the operation — written when it
-- opens, before the forward write — turns that from an in-memory intention into an
-- obligation any later process can discharge.
--
-- Non-null also marks an operation whose terminality belongs to the compensation pass:
-- the ordinary deadline sweep must not report it failed while its image is still the
-- durable desired state, because the change would then execute after the report.

-- AlterTable
ALTER TABLE "daemon_lifecycle_op" ADD COLUMN "commandImage" TEXT;
ALTER TABLE "daemon_lifecycle_op" ADD COLUMN "rollbackImage" TEXT;

-- Overdue pending operations are swept by status + deadline; the pass that discharges a
-- compensation selects on these columns too, so index the pending ones that carry them.
CREATE INDEX "daemon_lifecycle_op_compensation_idx" ON "daemon_lifecycle_op"("status", "deadline")
  WHERE "commandImage" IS NOT NULL;
