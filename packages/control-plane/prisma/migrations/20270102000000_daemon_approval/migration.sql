BEGIN;
CREATE TYPE "DaemonApprovalStatus" AS ENUM ('pending', 'approved', 'revoked');
ALTER TYPE "AuditKind" ADD VALUE 'daemon_approval';
COMMIT;

BEGIN;
-- The schema migration owns the legacy cohort; later inserts default to pending.
ALTER TABLE "daemon"
  ADD COLUMN "approvalStatus" "DaemonApprovalStatus" NOT NULL DEFAULT 'approved',
  ADD COLUMN "approvalRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "approvalSource" TEXT,
  ADD COLUMN "approvalChangedAt" TIMESTAMPTZ(6),
  ADD COLUMN "approvalChangedBy" TEXT;

UPDATE "daemon"
SET "approvalSource" = CASE WHEN "orgId" IS NULL AND "clusterIdentity" IS NOT NULL AND "clusterPodUid" IS NOT NULL
    THEN 'system' ELSE 'legacy_migration' END,
    "approvalChangedAt" = CURRENT_TIMESTAMP,
    "approvalRevision" = 1;

INSERT INTO "audit_event" ("kind", "orgId", "daemonId", "details")
SELECT 'daemon_approval', "orgId", "id",
  jsonb_build_object('status', 'approved', 'source', "approvalSource", 'revision', 1,
    'migration', '20270102000000_daemon_approval', 'cutoff', CURRENT_TIMESTAMP)
FROM "daemon";

ALTER TABLE "daemon" ALTER COLUMN "approvalStatus" SET DEFAULT 'pending';
COMMIT;
