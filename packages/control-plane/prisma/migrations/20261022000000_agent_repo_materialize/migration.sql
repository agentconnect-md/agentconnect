-- How a session stands in each authorized repository (docs/designs/multi-repository-workspaces.md decision 13).
-- Additive: every existing grant defaults to always, which is the behavior it already had.
BEGIN;

CREATE TYPE "RepoMaterialization" AS ENUM ('always', 'decision', 'on-demand');

ALTER TABLE "agent_repo_authorization"
  ADD COLUMN "materialize" "RepoMaterialization" NOT NULL DEFAULT 'always';

COMMIT;
