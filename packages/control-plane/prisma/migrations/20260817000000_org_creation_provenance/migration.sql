-- Persist who created each organization so creation quotas do not count an org
-- where somebody else later granted the user the owner role.
ALTER TABLE "public"."org" ADD COLUMN "createdByUserId" TEXT;

-- Existing application-created orgs had their creator's membership inserted first,
-- including personal orgs. Preserve that provenance for the new quota semantics.
UPDATE "public"."org" AS org
SET "createdByUserId" = first_membership."userId"
FROM (
  SELECT DISTINCT ON ("orgId") "orgId", "userId"
  FROM "public"."membership"
  ORDER BY "orgId", "createdAt", "id"
) AS first_membership
WHERE org."id" = first_membership."orgId";

CREATE INDEX "org_createdByUserId_idx" ON "public"."org"("createdByUserId" ASC);

ALTER TABLE "public"."org"
  ADD CONSTRAINT "org_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "public"."app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
