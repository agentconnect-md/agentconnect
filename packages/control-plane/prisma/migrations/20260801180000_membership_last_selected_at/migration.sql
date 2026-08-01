-- Remember the active organization on the user-org relationship. Keeping the
-- preference on membership makes it disappear automatically when access ends.
ALTER TABLE "membership" ADD COLUMN "lastSelectedAt" TIMESTAMPTZ(6);
