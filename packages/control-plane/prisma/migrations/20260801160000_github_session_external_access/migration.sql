-- GitHub hook sessions become repository-scoped external candidates. The
-- numeric repository id is the immutable audience key; installation and
-- owner/repo names are only credential/routing metadata.

-- Identify every historical GitHub root we can prove from a HookRun snapshot,
-- plus current github HookDefs for mixed legacy rows. Descendants inherit the
-- same fail-closed candidate boundary.
INSERT INTO "session_external_access_policy" (
  "orgId", "provider", "state", "currentRev", "createdAt", "updatedAt"
)
WITH RECURSIVE direct_candidates AS (
  SELECT DISTINCT s."id"
  FROM "session_meta" s
  LEFT JOIN "hook_run" run
    ON run."sessionId" = s."id"
   AND run."orgId" = s."orgId"
   AND run."agentId" = s."agentId"
   AND run."repoId" IS NOT NULL
  LEFT JOIN "hook_def" hook
    ON hook."orgId" = s."orgId"
   AND hook."agentId" = s."agentId"
   AND hook."kind" = 'github'::"HookKind"
   AND (
     s."triggeredBy" = 'hook:' || hook."id"::text
     OR (s."platform" = 'hook' AND s."channel" = hook."id"::text)
   )
  WHERE run."id" IS NOT NULL OR hook."id" IS NOT NULL
), candidates AS (
  SELECT "id" FROM direct_candidates
  UNION
  SELECT child."id"
  FROM "session_meta" child
  JOIN candidates parent ON child."parentSessionId" = parent."id"
)
SELECT DISTINCT s."orgId", 'github', 'disabled'::"ExternalAccessPolicyState", 0,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "session_meta" s
JOIN candidates c ON c."id" = s."id"
ON CONFLICT ("orgId", "provider") DO NOTHING;

WITH RECURSIVE direct_candidates AS (
  SELECT DISTINCT s."id"
  FROM "session_meta" s
  LEFT JOIN "hook_run" run
    ON run."sessionId" = s."id"
   AND run."orgId" = s."orgId"
   AND run."agentId" = s."agentId"
   AND run."repoId" IS NOT NULL
  LEFT JOIN "hook_def" hook
    ON hook."orgId" = s."orgId"
   AND hook."agentId" = s."agentId"
   AND hook."kind" = 'github'::"HookKind"
   AND (
     s."triggeredBy" = 'hook:' || hook."id"::text
     OR (s."platform" = 'hook' AND s."channel" = hook."id"::text)
   )
  WHERE run."id" IS NOT NULL OR hook."id" IS NOT NULL
), candidates AS (
  SELECT "id" FROM direct_candidates
  UNION
  SELECT child."id"
  FROM "session_meta" child
  JOIN candidates parent ON child."parentSessionId" = parent."id"
)
UPDATE "session_meta" s
SET "externalProvider" = 'github',
    "externalResolution" = CASE
      WHEN s."visibility" = 'private'::"SessionVisibility"
        THEN 'invalid'::"ExternalResolution"
      ELSE 'pending'::"ExternalResolution"
    END,
    "visibility" = CASE
      WHEN s."visibility" = 'private'::"SessionVisibility"
        THEN 'external'::"SessionVisibility"
      ELSE s."visibility"
    END,
    "classifiedPolicyRev" = 0,
    "visibilityRev" = s."visibilityRev" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
FROM candidates c
WHERE s."id" = c."id"
  AND s."externalProvider" IS NULL;

-- A session is safely backfillable only when all accepted HookRuns tied to it
-- name one numeric repository. Pick its latest known installation credential;
-- repository rename never changes the ExternalScope identity.
WITH consistent AS (
  SELECT s."id" AS "sessionId", s."orgId", s."agentId", MIN(run."repoId") AS "repoId"
  FROM "session_meta" s
  JOIN "hook_run" run
    ON run."sessionId" = s."id"
   AND run."orgId" = s."orgId"
   AND run."agentId" = s."agentId"
  WHERE s."externalProvider" = 'github'
    AND s."externalResolution" <> 'invalid'::"ExternalResolution"
  GROUP BY s."id", s."orgId", s."agentId"
  HAVING COUNT(*) FILTER (WHERE run."repoId" IS NULL) = 0
     AND COUNT(DISTINCT run."repoId") = 1
), ranked AS (
  SELECT consistent.*, installation."id" AS "credentialId",
         run."startedAt", run."id" AS "runId"
  FROM consistent
  JOIN "hook_run" run
    ON run."sessionId" = consistent."sessionId"
   AND run."orgId" = consistent."orgId"
   AND run."agentId" = consistent."agentId"
   AND run."repoId" = consistent."repoId"
  JOIN "github_installation" installation
    ON installation."orgId" = consistent."orgId"
   AND installation."installationId" = run."sourceInstallationId"
), scopes AS (
  SELECT DISTINCT ON ("orgId", "repoId") "orgId", "repoId", "credentialId"
  FROM ranked
  ORDER BY "orgId", "repoId", "startedAt" DESC, "runId" DESC
)
INSERT INTO "external_scope" (
  "id", "orgId", "provider", "realmKey", "resourceKind", "resourceKey",
  "credentialKind", "credentialId", "aclRevision", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), "orgId", 'github', 'github.com', 'repository', "repoId"::text,
       'github_installation', "credentialId", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM scopes
ON CONFLICT ("orgId", "provider", "realmKey", "resourceKind", "resourceKey")
DO UPDATE SET
  "credentialKind" = EXCLUDED."credentialKind",
  "credentialId" = EXCLUDED."credentialId",
  "aclRevision" = "external_scope"."aclRevision" + CASE
    WHEN "external_scope"."credentialId" IS DISTINCT FROM EXCLUDED."credentialId" THEN 1
    ELSE 0
  END,
  "revokedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

WITH RECURSIVE consistent AS (
  SELECT s."id" AS "sessionId", s."orgId", s."agentId", MIN(run."repoId") AS "repoId"
  FROM "session_meta" s
  JOIN "hook_run" run
    ON run."sessionId" = s."id"
   AND run."orgId" = s."orgId"
   AND run."agentId" = s."agentId"
  WHERE s."externalProvider" = 'github'
    AND s."externalResolution" <> 'invalid'::"ExternalResolution"
  GROUP BY s."id", s."orgId", s."agentId"
  HAVING COUNT(*) FILTER (WHERE run."repoId" IS NULL) = 0
     AND COUNT(DISTINCT run."repoId") = 1
), roots AS (
  SELECT consistent."sessionId" AS "id", scope."id" AS "scopeId"
  FROM consistent
  JOIN "session_meta" s
    ON s."id" = consistent."sessionId"
   AND s."orgId" = consistent."orgId"
   AND s."agentId" = consistent."agentId"
  JOIN "external_scope" scope
    ON scope."orgId" = consistent."orgId"
   AND scope."provider" = 'github'
   AND scope."realmKey" = 'github.com'
   AND scope."resourceKind" = 'repository'
   AND scope."resourceKey" = consistent."repoId"::text
), family AS (
  SELECT "id", "scopeId" FROM roots
  UNION
  SELECT child."id", parent."scopeId"
  FROM "session_meta" child
  JOIN family parent ON child."parentSessionId" = parent."id"
)
UPDATE "session_meta" s
SET "externalScopeId" = family."scopeId",
    "externalResolution" = 'settled'::"ExternalResolution",
    "updatedAt" = CURRENT_TIMESTAMP
FROM family
WHERE s."id" = family."id"
  AND s."externalProvider" = 'github'
  AND s."visibility" <> 'private'::"SessionVisibility";
