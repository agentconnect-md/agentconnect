-- Per-member read watermark for a session (ids and a stamp only): activity after it is unread in the console.
-- CreateTable
CREATE TABLE "session_read_state" (
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_read_state_pkey" PRIMARY KEY ("userId", "sessionId")
);

-- CreateIndex
CREATE INDEX "session_read_state_sessionId_idx" ON "session_read_state"("sessionId");

-- AddForeignKey
ALTER TABLE "session_read_state" ADD CONSTRAINT "session_read_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_read_state" ADD CONSTRAINT "session_read_state_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session_meta"("id") ON DELETE CASCADE ON UPDATE CASCADE;
