-- Mark existing GitLab hook conversations and inherited children before permission sync can be enabled.
WITH RECURSIVE candidates AS (
  SELECT s."id", s."orgId" FROM "session_meta" s
  LEFT JOIN "hook_def" h ON h."orgId" = s."orgId" AND h."agentId" = s."agentId" AND h."kind" = 'gitlab'
    AND (s."triggeredBy" = 'hook:' || h."id"::text OR (s."platform" = 'hook' AND s."channel" = h."id"::text))
  WHERE s."parentSessionId" IS NULL AND s."externalProvider" IS NULL
    AND s."visibility" = 'org' AND s."visibilitySource" <> 'explicit'
    AND (s."hookKind" = 'gitlab' OR h."id" IS NOT NULL OR (s."platform" = 'hook' AND s."thread" LIKE 'gitlab:%'))
  UNION
  SELECT c."id", c."orgId" FROM "session_meta" c
  JOIN candidates p ON c."parentSessionId" = p."id" AND c."orgId" = p."orgId"
  WHERE c."externalProvider" IS NULL AND c."visibilitySource" IN ('inherited', 'inherited_pending')
), policies AS (
  INSERT INTO "session_external_access_policy" ("orgId", "provider", "updatedAt")
  SELECT DISTINCT "orgId", 'gitlab', CURRENT_TIMESTAMP FROM candidates
  ON CONFLICT ("orgId", "provider") DO NOTHING
)
UPDATE "session_meta" s SET "externalProvider" = 'gitlab', "externalResolution" = 'pending',
  "classifiedPolicyRev" = 0, "visibilityRev" = s."visibilityRev" + 1, "updatedAt" = CURRENT_TIMESTAMP
FROM candidates c WHERE s."id" = c."id";
