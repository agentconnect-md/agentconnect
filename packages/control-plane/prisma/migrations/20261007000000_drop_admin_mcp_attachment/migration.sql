-- The admin catalog is entitled by the webchat surface again, not by attachment
-- (docs/designs/webchat-preset-agentconnect-mcp.md §1): every agent receives it in its owner's
-- private webchat, and `agentconnect-admin` is no longer an enable-list name. Strip the entry
-- 20261006000000 added (and any the console attached meanwhile) so no daemon sees a name it
-- cannot configure.
--
-- Idempotent: an agent that never carried the name is untouched, and an emptied list is kept as
-- an empty array rather than removed, which reads the same to the spec assembler.
UPDATE "agent"
SET "runtimeOverrides" = jsonb_set(
      "runtimeOverrides",
      '{mcpServers}',
      COALESCE(
        (
          SELECT jsonb_agg(entry)
          FROM jsonb_array_elements("runtimeOverrides" -> 'mcpServers') AS entry
          WHERE entry <> '"agentconnect-admin"'::jsonb
        ),
        '[]'::jsonb
      ),
      true
    )
WHERE jsonb_typeof("runtimeOverrides" -> 'mcpServers') = 'array'
  AND "runtimeOverrides" -> 'mcpServers' @> '["agentconnect-admin"]'::jsonb;
