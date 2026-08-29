-- git-workspace-model.md §4: the workspace discriminant collapses to scratch|git;
-- who vouches for the repository becomes the explicit gitCredentialProvider column
-- ('github' | 'gitlab' | NULL = anonymous). Provider cannot be derived from the
-- existing columns because workspaceRepoId is shared between GitHub's repo id and
-- GitLab's project id.
ALTER TABLE "agent" ADD COLUMN "gitCredentialProvider" TEXT;

-- Backfill provenance from the host-shaped rows before the discriminant collapses:
-- App-backed github rows carry an installation, gitlab rows are always managed,
-- everything else stays anonymous.
UPDATE "agent" SET "gitCredentialProvider" = 'github'
  WHERE "workspaceMode"::text = 'github' AND "installationId" IS NOT NULL;
UPDATE "agent" SET "gitCredentialProvider" = 'gitlab'
  WHERE "workspaceMode"::text = 'gitlab' AND "workspaceRepoId" IS NOT NULL;

-- Rewrite github|gitlab → git and drop the legacy enum values.
CREATE TYPE "WorkspaceMode_new" AS ENUM ('scratch', 'git');
ALTER TABLE "agent" ALTER COLUMN "workspaceMode" DROP DEFAULT;
ALTER TABLE "agent"
  ALTER COLUMN "workspaceMode" TYPE "WorkspaceMode_new"
  USING (CASE WHEN "workspaceMode"::text = 'scratch' THEN 'scratch' ELSE 'git' END::"WorkspaceMode_new");
ALTER TYPE "WorkspaceMode" RENAME TO "WorkspaceMode_old";
ALTER TYPE "WorkspaceMode_new" RENAME TO "WorkspaceMode";
DROP TYPE "WorkspaceMode_old";
ALTER TABLE "agent" ALTER COLUMN "workspaceMode" SET DEFAULT 'scratch';
