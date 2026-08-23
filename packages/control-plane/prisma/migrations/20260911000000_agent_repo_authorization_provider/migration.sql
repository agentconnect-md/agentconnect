-- Provider-qualify an agent's explicit repository grants (gitlab-com-integration.md §8.3).
--
-- GitHub and GitLab number their repositories independently, so a bare `repoId` is not an
-- identity once GitLab grants exist: one agent could legitimately hold a grant on GitHub
-- repository 4455667 and on GitLab project 4455667. Every row on record predates GitLab
-- grants and is a GitHub grant, so the column default IS the backfill.
ALTER TABLE "agent_repo_authorization" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'github';

DROP INDEX "agent_repo_authorization_agentId_repoId_key";

CREATE UNIQUE INDEX "agent_repo_authorization_agentId_provider_repoId_key" ON "agent_repo_authorization" ("agentId", "provider", "repoId");
