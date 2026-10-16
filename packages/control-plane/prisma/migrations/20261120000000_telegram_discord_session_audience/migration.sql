-- Mark historical conversations and their inherited children before an owner can enable the read fence.
WITH RECURSIVE candidates AS (
  SELECT "id", "orgId", "platform" AS provider FROM "session_meta"
  WHERE "platform" IN ('telegram', 'discord')
    AND ("parentSessionId" IS NULL OR "visibilitySource" = 'default') AND "launchId" IS NULL
    AND "externalProvider" IS NULL AND "visibility" = 'org' AND "visibilitySource" <> 'explicit'
    AND "channel" ~ '^-?[1-9][0-9]*$'
  UNION
  SELECT c."id", c."orgId", p.provider FROM "session_meta" c
  JOIN candidates p ON c."parentSessionId" = p."id" AND c."orgId" = p."orgId"
  WHERE c."externalProvider" IS NULL AND c."visibilitySource" IN ('inherited', 'inherited_pending')
), policies AS (
  INSERT INTO "session_external_access_policy" ("orgId", "provider", "updatedAt")
  SELECT DISTINCT "orgId", provider, CURRENT_TIMESTAMP FROM candidates
  ON CONFLICT ("orgId", "provider") DO NOTHING
)
UPDATE "session_meta" s SET "externalProvider" = c.provider, "externalResolution" = 'pending',
  "classifiedPolicyRev" = 0,
  "visibilityRev" = s."visibilityRev" + 1, "updatedAt" = CURRENT_TIMESTAMP
FROM candidates c WHERE s."id" = c."id";
