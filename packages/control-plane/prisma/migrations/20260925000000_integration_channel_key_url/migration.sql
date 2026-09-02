-- A conversation's short platform handle and the page it opens there
-- (docs/designs/linear-integration.md §4.5): a Linear team has a key ("ENG") and a team URL, and
-- the console prints the key after the team name and links the name to that page.
--
-- Additive and nullable, and carried as their own fields rather than parsed back out of the
-- stored label. Linear rows are stamped by the connect tail, the credential reconciler's team
-- pass, and the daemon's next conversation report. No other platform ever writes them.
ALTER TABLE "integration_channel" ADD COLUMN "key" TEXT;
ALTER TABLE "integration_channel" ADD COLUMN "url" TEXT;
