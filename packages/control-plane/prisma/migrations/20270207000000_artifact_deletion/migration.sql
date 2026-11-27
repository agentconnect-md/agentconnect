-- A deleted artifact's object keys, kept until the bucket no longer holds them (artifacts.md §5.6, §10.1).
-- CreateTable
CREATE TABLE "artifact_deletion" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "objectKeys" TEXT[],
    "deletedAt" TIMESTAMPTZ(3) NOT NULL,
    "purgeAfter" TIMESTAMPTZ(3) NOT NULL,
    "sweptAt" TIMESTAMPTZ(3),

    CONSTRAINT "artifact_deletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artifact_deletion_purgeAfter_idx" ON "artifact_deletion"("purgeAfter");
