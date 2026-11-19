-- Shared-file snapshots (agent-authored-attachments.md §4.1): the bucket key, digest and size; the bytes live in the transfer bucket.
-- CreateTable
CREATE TABLE "session_file_snapshot" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "name" TEXT,
    "objectKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_file_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_file_snapshot_objectKey_key" ON "session_file_snapshot"("objectKey");

-- CreateIndex
CREATE INDEX "session_file_snapshot_orgId_sessionId_sha256_idx" ON "session_file_snapshot"("orgId", "sessionId", "sha256");

-- CreateIndex
CREATE INDEX "session_file_snapshot_sessionId_idx" ON "session_file_snapshot"("sessionId");
