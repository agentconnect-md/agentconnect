-- Stable worklist indexes for bounded invocation recovery. The id tie-breaker
-- makes every SKIP LOCKED batch deterministic without blocking behind a worker
-- that already owns an older candidate.
DROP INDEX "mcp_invocation_status_assertionExpires_idx";

CREATE INDEX "mcp_invocation_status_assertionExpires_id_idx"
  ON "mcp_invocation"("status", "assertionExpires", "id");

CREATE INDEX "mcp_invocation_status_startedAt_id_idx"
  ON "mcp_invocation"("status", "startedAt", "id");

CREATE INDEX "mcp_invocation_status_completedAt_id_idx"
  ON "mcp_invocation"("status", "completedAt", "id");
