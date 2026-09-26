-- Installation-wide GitHub rows (webhook-triggers-and-github-events.md, Installation-Wide Rows): a row watches one repository or every repository of one installation.
ALTER TABLE "hook_def" ADD COLUMN "installationId" BIGINT, ADD COLUMN "installationAccount" TEXT;

ALTER TABLE "hook_def" ADD CONSTRAINT "hook_def_repo_or_installation_check"
  CHECK ("installationId" IS NULL OR ("repoId" IS NULL AND "kind" = 'github' AND "installationAccount" IS NOT NULL));

CREATE UNIQUE INDEX "hook_def_agent_installation_family_key" ON "hook_def"("agentId", "kind", "installationId", "family");

CREATE INDEX "hook_def_kind_installationId_idx" ON "hook_def"("kind", "installationId");
