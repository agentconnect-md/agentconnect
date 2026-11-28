-- The producing agent on the artifact row, so pruning revision 1 (artifacts.md §10.1) keeps the §7.2 check working.
ALTER TABLE "artifact" ADD COLUMN "producedByAgentId" UUID;

-- Backfill from revision 1, or from the earliest remaining ready revision where retention already pruned it.
UPDATE "artifact" a
SET "producedByAgentId" = (
  SELECT r."producedByAgentId" FROM "artifact_revision" r
  WHERE r."artifactId" = a."id" AND (r."number" = 1 OR r."state" = 'ready')
  ORDER BY r."number" ASC
  LIMIT 1
);
