-- Concurrent updates (artifacts.md §5.6): an update records its base, and a revision refused at completion is closed.
ALTER TYPE "ArtifactRevisionState" ADD VALUE 'closed';
ALTER TABLE "artifact_revision" ADD COLUMN "baseRevision" INTEGER;
-- A closed revision releases its key, so publishing the same content again starts a new revision.
ALTER TABLE "artifact_revision" ALTER COLUMN "idempotencyKey" DROP NOT NULL;
