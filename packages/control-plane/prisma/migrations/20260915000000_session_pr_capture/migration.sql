CREATE TABLE "session_pull_request_capture" (
  "sessionId" TEXT NOT NULL,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL,
  "claimOwner" UUID,
  "claimUntil" TIMESTAMPTZ(6),
  CONSTRAINT "session_pull_request_capture_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "session_pull_request_capture_pending_idx"
  ON "session_pull_request_capture"("nextAttemptAt", "claimUntil");

ALTER TABLE "session_pull_request_capture"
  ADD CONSTRAINT "session_pull_request_capture_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "session_meta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
