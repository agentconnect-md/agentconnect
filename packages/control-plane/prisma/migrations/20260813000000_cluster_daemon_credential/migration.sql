-- AlterTable
ALTER TABLE "org_cluster_execution" ADD COLUMN     "credentialApiKeyId" TEXT,
ADD COLUMN     "credentialDaemonId" UUID,
ADD COLUMN     "credentialRotationAt" TIMESTAMPTZ(6),
ADD COLUMN     "credentialRotationToken" TEXT,
ADD COLUMN     "credentialRotationSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credentialStagedApiKeyId" TEXT;

-- CreateTable
CREATE TABLE "pending_daemon_key_revocation" (
    "apiKeyId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "held" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_daemon_key_revocation_pkey" PRIMARY KEY ("apiKeyId")
);
