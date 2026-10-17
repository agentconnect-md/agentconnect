-- The organization record keeps no research day of its own: research's day is its last research revision (assistant-mode.md §5.16).
ALTER TABLE "organization_record" DROP COLUMN "researchedAt";
