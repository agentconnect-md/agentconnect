-- Artifacts and their revisions (artifacts.md §4): metadata only, the bytes live in the transfer bucket.
-- CreateEnum
CREATE TYPE "ArtifactStorageMode" AS ENUM ('signed', 'public');

-- CreateEnum
CREATE TYPE "ArtifactRevisionState" AS ENUM ('pending', 'ready');

-- CreateTable
CREATE TABLE "artifact" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerIdentity" TEXT,
    "visibility" "SessionVisibility" NOT NULL,
    "externalProvider" TEXT,
    "externalScopeId" UUID,
    "editorsAgentId" UUID,
    "originSessionId" TEXT,
    "latestRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_pkey" PRIMARY KEY ("id"),
    -- The copied audience scope is present exactly for its tier (artifacts.md §6.2).
    CONSTRAINT "artifact_external_scope_shape" CHECK (
        ("visibility" = 'external' AND "externalProvider" IS NOT NULL AND "externalScopeId" IS NOT NULL)
        OR ("visibility" <> 'external' AND "externalProvider" IS NULL AND "externalScopeId" IS NULL)
    ),
    CONSTRAINT "artifact_editors_agent_shape" CHECK (("visibility" = 'editors') = ("editorsAgentId" IS NOT NULL)),
    CONSTRAINT "artifact_latest_revision_nonnegative" CHECK ("latestRevision" >= 0)
);

-- CreateTable
CREATE TABLE "artifact_revision" (
    "id" UUID NOT NULL,
    "artifactId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "storageMode" "ArtifactStorageMode" NOT NULL,
    "storagePrefix" TEXT NOT NULL,
    "producedByAgentId" UUID NOT NULL,
    "producedByAgentName" TEXT NOT NULL,
    "producedInSessionId" TEXT NOT NULL,
    "initiatedBy" TEXT,
    "totalBytes" INTEGER NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "state" "ArtifactRevisionState" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_revision_number_positive" CHECK ("number" >= 1),
    CONSTRAINT "artifact_revision_counts_valid" CHECK ("fileCount" >= 1 AND "totalBytes" >= 0)
);

-- CreateIndex
CREATE INDEX "artifact_orgId_updatedAt_id_idx" ON "artifact"("orgId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "artifact_orgId_externalProvider_externalScopeId_idx" ON "artifact"("orgId", "externalProvider", "externalScopeId");

-- CreateIndex
CREATE INDEX "artifact_orgId_editorsAgentId_idx" ON "artifact"("orgId", "editorsAgentId");

-- CreateIndex
CREATE INDEX "artifact_orgId_ownerIdentity_idx" ON "artifact"("orgId", "ownerIdentity");

-- CreateIndex
CREATE INDEX "artifact_originSessionId_idx" ON "artifact"("originSessionId");

-- CreateIndex
CREATE INDEX "artifact_revision_producedInSessionId_idx" ON "artifact_revision"("producedInSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_revision_artifactId_number_key" ON "artifact_revision"("artifactId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_revision_producedByAgentId_idempotencyKey_key" ON "artifact_revision"("producedByAgentId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "artifact_revision" ADD CONSTRAINT "artifact_revision_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

