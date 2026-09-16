-- Delegated admin catalog by attachment (docs/designs/webchat-preset-agentconnect-mcp.md §1):
-- entitlement is now the agent's own `mcpServers` enable-list carrying `agentconnect-admin`,
-- not its preset identity. New orgs are provisioned with it attached; every existing live
-- general preset agent gets the same entry here so an upgrade does not withdraw the catalog.
--
-- Idempotent and additive: an agent that already carries the name is untouched, and no other
-- agent is given one.
UPDATE "agent" AS a
SET "runtimeOverrides" = jsonb_set(
      COALESCE(a."runtimeOverrides", '{}'::jsonb),
      '{mcpServers}',
      COALESCE(a."runtimeOverrides" -> 'mcpServers', '[]'::jsonb) || '["agentconnect-admin"]'::jsonb,
      true
    )
FROM "preset_agent" AS p
WHERE p."agentId" = a."id"
  AND p."preset" = 'general'
  AND p."status" = 'created'
  AND NOT COALESCE(a."runtimeOverrides" -> 'mcpServers', '[]'::jsonb) @> '["agentconnect-admin"]'::jsonb;
