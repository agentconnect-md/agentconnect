ALTER TABLE "session_meta"
  ADD COLUMN "pullRequestRepoId" BIGINT,
  ADD COLUMN "pullRequestRepoFullName" TEXT,
  ADD COLUMN "pullRequestInstallationId" BIGINT,
  ADD COLUMN "pullRequestNumber" INTEGER,
  ADD COLUMN "pullRequestLinkedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "session_meta_pull_request_key"
  ON "session_meta"("pullRequestRepoId", "pullRequestNumber");

CREATE TABLE "session_pull_request_feedback" (
  "id" UUID NOT NULL,
  "deliveryKey" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "installationId" BIGINT NOT NULL,
  "repoId" BIGINT NOT NULL,
  "repoFullName" TEXT NOT NULL,
  "pullNumber" INTEGER NOT NULL,
  "event" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" TEXT,
  "observedAt" TIMESTAMPTZ(6) NOT NULL,
  "sessionId" TEXT,
  "claimOwner" UUID,
  "claimUntil" TIMESTAMPTZ(6),
  "deliveredAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "session_pull_request_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_pull_request_feedback_deliveryKey_key"
  ON "session_pull_request_feedback"("deliveryKey");
CREATE INDEX "session_pr_feedback_pending_idx"
  ON "session_pull_request_feedback"("sessionId", "deliveredAt", "createdAt");
CREATE INDEX "session_pr_feedback_link_idx"
  ON "session_pull_request_feedback"("orgId", "repoId", "pullNumber", "sessionId");

ALTER TABLE "session_pull_request_feedback"
  ADD CONSTRAINT "session_pull_request_feedback_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session_meta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
