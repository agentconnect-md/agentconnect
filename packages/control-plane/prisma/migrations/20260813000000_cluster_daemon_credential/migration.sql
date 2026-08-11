-- AlterTable
ALTER TABLE "org_cluster_execution" ADD COLUMN     "credentialApiKeyId" TEXT,
ADD COLUMN     "credentialDaemonId" UUID;
