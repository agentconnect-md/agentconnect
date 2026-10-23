-- Fence historical conversations and inherited children before permission sync can be enabled.
WITH RECURSIVE candidates AS (
  SELECT "id", "orgId" FROM "session_meta"
  WHERE "platform" = 'msteams'
    AND ("parentSessionId" IS NULL OR "visibilitySource" = 'default') AND "launchId" IS NULL
    AND "externalProvider" IS NULL AND "visibility" = 'org' AND "visibilitySource" <> 'explicit'
    AND "channel" ~ '^(19:[A-Za-z0-9_.@-]{1,190}|a:[A-Za-z0-9_-]{1,190})$'
  UNION
  SELECT c."id", c."orgId" FROM "session_meta" c
  JOIN candidates p ON c."parentSessionId" = p."id" AND c."orgId" = p."orgId"
  WHERE c."externalProvider" IS NULL AND c."visibilitySource" IN ('inherited', 'inherited_pending')
), policies AS (
  INSERT INTO "session_external_access_policy" ("orgId", "provider", "updatedAt")
  SELECT DISTINCT "orgId", 'msteams', CURRENT_TIMESTAMP FROM candidates
  ON CONFLICT ("orgId", "provider") DO NOTHING
)
UPDATE "session_meta" s SET "externalProvider" = 'msteams', "externalResolution" = 'pending',
  "classifiedPolicyRev" = 0,
  "visibilityRev" = s."visibilityRev" + 1, "updatedAt" = CURRENT_TIMESTAMP
FROM candidates c WHERE s."id" = c."id";
