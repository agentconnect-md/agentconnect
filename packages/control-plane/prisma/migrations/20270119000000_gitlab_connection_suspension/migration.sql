-- A member's code-host authority stops when the membership is suspended, as it does when it is deleted.
-- Lifting the suspension does not reconnect: the member connects again.
CREATE TRIGGER gitlab_connection_suspension_guard
AFTER UPDATE OF "suspendedAt" ON "membership"
FOR EACH ROW
WHEN (OLD."suspendedAt" IS NULL AND NEW."suspendedAt" IS NOT NULL)
EXECUTE FUNCTION gitlab_connection_disconnect_on_membership_delete();
