ALTER TABLE "session_meta"
  ADD COLUMN "pullRequestRepoId" BIGINT,
  ADD COLUMN "pullRequestRepoFullName" TEXT,
  ADD COLUMN "pullRequestInstallationId" BIGINT,
  ADD COLUMN "pullRequestNumber" INTEGER,
  ADD COLUMN "pullRequestLinkedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "session_meta_pull_request_key"
  ON "session_meta"("pullRequestRepoId", "pullRequestNumber");

CREATE TABLE "session_pull_request_wake" (
  "id" UUID NOT NULL,
  "orgId" TEXT NOT NULL,
  "installationId" BIGINT NOT NULL,
  "repoId" BIGINT NOT NULL,
  "repoFullName" TEXT NOT NULL,
  "pullNumber" INTEGER NOT NULL,
  "latestDeliveryKey" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "sessionId" TEXT,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL,
  "claimOwner" UUID,
  "claimUntil" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_pull_request_wake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_pr_wake_key"
  ON "session_pull_request_wake"("orgId", "repoId", "pullNumber");
CREATE INDEX "session_pr_wake_pending_idx"
  ON "session_pull_request_wake"("deliveredAt", "nextAttemptAt", "claimUntil");

ALTER TABLE "session_pull_request_wake"
  ADD CONSTRAINT "session_pull_request_wake_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session_meta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
