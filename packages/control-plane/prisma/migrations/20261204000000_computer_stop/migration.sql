-- A console Stop holds the Computer paused until someone resumes it there (computer-use.md §6).
ALTER TABLE "computer" ADD COLUMN "stoppedAt" TIMESTAMPTZ(6),
ADD COLUMN "stoppedByUserId" TEXT;
