-- Backfill App-backed workspace clone URLs from the freshest accepted GitHub
-- source fact already converged into HookDef by the prior rename-continuity
-- release. Numeric repo identity keeps this immune to owner/repo renames.
WITH canonical_repo_name AS (
  SELECT DISTINCT ON (h."orgId", h."repoId")
    h."orgId",
    h."repoId",
    h."repoFullName"
  FROM "hook_def" h
  WHERE h."kind" = 'github'
    AND h."repoId" IS NOT NULL
    AND h."repoFullName" IS NOT NULL
    AND h."lastFiredAt" IS NOT NULL
  ORDER BY h."orgId", h."repoId", h."lastFiredAt" DESC, h."id"
)
UPDATE "agent" a
SET "gitRepo" = 'https://github.com/' || c."repoFullName"
FROM canonical_repo_name c
WHERE a."orgId" = c."orgId"
  AND a."workspaceMode" = 'github'
  AND a."workspaceRepoId" = c."repoId"
  AND a."installationId" IS NOT NULL
  AND a."gitRepo" IS DISTINCT FROM 'https://github.com/' || c."repoFullName";
