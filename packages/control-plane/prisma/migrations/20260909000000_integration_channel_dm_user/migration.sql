-- The 1:1 DM counterpart's platform member id (resource-visibility.md §14.8).
-- Additive and nullable: rows discovered before this migration keep whatever
-- trigger an operator already chose, and are re-stamped by the reporter's next
-- conversation report.
ALTER TABLE "integration_channel" ADD COLUMN "dmUserId" TEXT;
