-- Two-tier session retention: a finished session's workspace keeps the 7-day window, its row and transcript default to 90 days.
ALTER TABLE "daemon" ADD COLUMN "workspaceRetention" TEXT NOT NULL DEFAULT '7d';

ALTER TABLE "daemon" ALTER COLUMN "sessionRetention" SET DEFAULT '90d';

-- A daemon on the old default kept everything for 7 days: its workspace still does, its transcripts follow the new default.
UPDATE "daemon" SET "sessionRetention" = '90d' WHERE "sessionRetention" = '7d';
