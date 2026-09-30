ALTER TABLE "session_pull_request"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'github',
  ADD COLUMN "bindingId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "host" TEXT,
  ADD COLUMN "headSha" TEXT,
  ADD COLUMN "sourceAgentId" UUID,
  ADD COLUMN "sourceSessionId" TEXT,
  ALTER COLUMN "installationId" DROP NOT NULL;
ALTER TABLE "session_pull_request" DROP CONSTRAINT "session_pull_request_pkey";
ALTER TABLE "session_pull_request" ADD CONSTRAINT "session_pull_request_pkey"
  PRIMARY KEY ("orgId", "provider", "bindingId", "repoId", "pullNumber");
ALTER TABLE "session_pull_request_delivery"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'github',
  ADD COLUMN "bindingId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "repoId" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "pullNumber" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "session_pull_request_delivery" DROP CONSTRAINT "session_pull_request_delivery_pkey";
ALTER TABLE "session_pull_request_delivery" ADD CONSTRAINT "session_pull_request_delivery_pkey"
  PRIMARY KEY ("orgId", "provider", "bindingId", "repoId", "pullNumber", "deliveryKey");

-- Existing writable workspaces acquire feedback subscriptions through the durable convergence sweep.
UPDATE "gitlab_project_binding" SET "convergeOwedAt" = CURRENT_TIMESTAMP WHERE "state" <> 'cleanup_pending';
UPDATE "gitea_repository_binding" SET "convergeOwedAt" = CURRENT_TIMESTAMP WHERE "state" <> 'cleanup_pending';
