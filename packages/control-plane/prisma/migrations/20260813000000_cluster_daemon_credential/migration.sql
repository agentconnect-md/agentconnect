-- AlterTable
ALTER TABLE "org_cluster_execution" ADD COLUMN     "credentialApiKeyId" TEXT,
ADD COLUMN     "credentialDaemonId" UUID,
ADD COLUMN     "credentialRotationAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "pending_daemon_key_revocation" (
    "apiKeyId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_daemon_key_revocation_pkey" PRIMARY KEY ("apiKeyId")
);
