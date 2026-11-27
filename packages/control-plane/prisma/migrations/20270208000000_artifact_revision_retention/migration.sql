-- The publishing daemon and its `sessions.retention`, which age an old revision (artifacts.md §10.1, P3).
-- AlterTable
ALTER TABLE "artifact_revision" ADD COLUMN "publishedByDaemonId" UUID,
ADD COLUMN "publishedRetention" TEXT;

-- CreateIndex
CREATE INDEX "artifact_revision_createdAt_idx" ON "artifact_revision"("createdAt");

-- Existing revisions take the daemon that recorded their session, where both rows are still there.
UPDATE "artifact_revision" r
SET "publishedByDaemonId" = d."id", "publishedRetention" = d."sessionRetention"
FROM "session_meta" s
JOIN "daemon" d ON d."id" = s."daemonId"
WHERE s."id" = r."producedInSessionId";
