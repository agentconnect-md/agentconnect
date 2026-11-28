-- Unfinished revision cleanup (artifacts.md §10.1): when PUTs were last signed; existing rows count from now, never too early.
ALTER TABLE "artifact_revision" ADD COLUMN "uploadsSignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Numbers come from a counter on the artifact, so removing the highest unfinished revision never frees its number or prefix.
ALTER TABLE "artifact" ADD COLUMN "revisionCounter" INTEGER NOT NULL DEFAULT 0;
UPDATE "artifact" a SET "revisionCounter" = COALESCE(
  (SELECT MAX(r."number") FROM "artifact_revision" r WHERE r."artifactId" = a."id"), 0);

CREATE INDEX "artifact_revision_state_uploadsSignedAt_idx" ON "artifact_revision"("state", "uploadsSignedAt");
