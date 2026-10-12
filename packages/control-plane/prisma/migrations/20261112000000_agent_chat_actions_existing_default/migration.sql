-- Existing agents start where a new one does: also approving tool calls in chat (product-conventions.md, "What people can do in chat").
-- Only the level the previous migration gave an agent that never allowed runtime changes moves; 'settings' stays.
-- A moved row's revision bumps, because a daemon refuses an equal revision whose digest differs.
UPDATE "agent"
SET
  "runtimeOverrides" = "runtimeOverrides" || jsonb_build_object('chatActions', 'approve'),
  "configRevision" = "configRevision" + 1
WHERE "runtimeOverrides" -> 'chatActions' = '"talk"'::jsonb;
