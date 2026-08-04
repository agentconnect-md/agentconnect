-- `Agent.daemonId` and `Agent.status` are two columns that must agree: unplaced ⇒
-- `inactive`. Only the repo's setPlacement/movePlacement wrote them as a pair, so
-- deleting a daemon (whose FK is `ON DELETE SET NULL`) cleared the placement while
-- leaving `status = 'active'` behind — the console then painted those agents online
-- and the `status = 'active'` gates kept treating them as runnable.
--
-- The route now unplaces explicitly before the delete; this reconciles the rows that
-- already drifted. `configRevision` is deliberately NOT bumped: these agents have no
-- owning daemon, so there is no recipient whose applied revision could be confused.

UPDATE "agent" SET "status" = 'inactive' WHERE "daemonId" IS NULL AND "status" = 'active';
