-- The last doctor report a desktop daemon sent on the Computer channel (computer-use.md §3.5, §3.6).
ALTER TABLE "computer" ADD COLUMN "doctor" JSONB;
