-- Share links to one artifact revision (artifacts.md §4, §8.3); only a peppered hash of each token is stored.
-- CreateEnum
CREATE TYPE "ArtifactShareAudience" AS ENUM ('public', 'org');

-- CreateTable
CREATE TABLE "artifact_share" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "artifactId" UUID NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayTail" TEXT NOT NULL,
    "audience" "ArtifactShareAudience" NOT NULL,
    "createdByIdentity" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "artifact_share_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_share_revision_positive" CHECK ("revisionNumber" >= 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "artifact_share_tokenHash_key" ON "artifact_share"("tokenHash");

-- CreateIndex
CREATE INDEX "artifact_share_artifactId_revisionNumber_idx" ON "artifact_share"("artifactId", "revisionNumber");

-- CreateIndex
CREATE INDEX "artifact_share_orgId_audience_idx" ON "artifact_share"("orgId", "audience");

-- AddForeignKey: deleting an artifact removes its shares (artifacts.md §10.1).
ALTER TABLE "artifact_share" ADD CONSTRAINT "artifact_share_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
