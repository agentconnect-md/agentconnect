CREATE TABLE "session_pull_request" (
  "orgId" TEXT NOT NULL,
  "repoId" BIGINT NOT NULL,
  "pullNumber" INTEGER NOT NULL,
  "installationId" BIGINT NOT NULL,
  "repoFullName" TEXT NOT NULL,
  "sessionId" TEXT,
  "deliveryKey" TEXT,
  "nextAttemptAt" TIMESTAMPTZ(6),
  "claimOwner" UUID,
  "claimUntil" TIMESTAMPTZ(6),
  "signalAt" TIMESTAMPTZ(6),
  CONSTRAINT "session_pull_request_pkey" PRIMARY KEY ("orgId", "repoId", "pullNumber")
);

CREATE UNIQUE INDEX "session_pull_request_session_key"
  ON "session_pull_request"("sessionId");
CREATE INDEX "session_pull_request_pending_idx"
  ON "session_pull_request"("nextAttemptAt", "claimUntil");

ALTER TABLE "session_pull_request"
  ADD CONSTRAINT "session_pull_request_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session_meta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
