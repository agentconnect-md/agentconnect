-- CreateEnum
CREATE TYPE "ClusterEgressPolicy" AS ENUM ('locked', 'curated', 'open');

-- CreateTable
CREATE TABLE "org_cluster_execution" (
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targetNamespace" TEXT NOT NULL,
    "suspend" BOOLEAN NOT NULL DEFAULT false,
    "daemonImage" TEXT NOT NULL,
    "daemonTier" TEXT NOT NULL DEFAULT 'small',
    "credentialSecretName" TEXT NOT NULL DEFAULT 'ac-daemon-token',
    "credentialRevision" TEXT,
    "runtimeImage" TEXT NOT NULL,
    "runtimeTiers" JSONB NOT NULL,
    "quotaMaxAgents" INTEGER NOT NULL DEFAULT 0,
    "quotaCpu" TEXT NOT NULL DEFAULT '0',
    "quotaMemory" TEXT NOT NULL DEFAULT '0',
    "quotaStorage" TEXT NOT NULL DEFAULT '0',
    "egressPolicy" "ClusterEgressPolicy" NOT NULL DEFAULT 'curated',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_cluster_execution_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_cluster_execution_targetNamespace_key" ON "org_cluster_execution"("targetNamespace");

-- AddForeignKey
ALTER TABLE "org_cluster_execution" ADD CONSTRAINT "org_cluster_execution_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
