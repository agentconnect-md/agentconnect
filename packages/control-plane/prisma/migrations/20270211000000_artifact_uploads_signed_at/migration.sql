-- Unfinished revision cleanup (artifacts.md §10.1): when PUTs were last signed; existing rows count from now, never too early.
ALTER TABLE "artifact_revision" ADD COLUMN "uploadsSignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "artifact_revision_state_uploadsSignedAt_idx" ON "artifact_revision"("state", "uploadsSignedAt");
