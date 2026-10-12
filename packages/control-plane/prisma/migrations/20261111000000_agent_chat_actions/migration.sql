-- Replace the agent's `allowRuntimeChangesInChat` boolean with `chatActions` (product-conventions.md, "What people can do in chat").
-- Existing agents keep their behavior: on becomes 'settings', off or never set becomes 'talk', and a row without overrides gets the bag.
-- A converted row's revision moves: its emitted spec changes, and a daemon refuses an equal revision whose digest differs.
-- Idempotent: a row that already carries `chatActions` and no longer carries the boolean is left as it is.
UPDATE "agent"
SET
  "runtimeOverrides" = (
    CASE WHEN jsonb_typeof("runtimeOverrides") = 'object' THEN "runtimeOverrides" ELSE '{}'::jsonb END
      - 'allowRuntimeChangesInChat'
  ) || jsonb_build_object(
    'chatActions',
    CASE WHEN "runtimeOverrides" -> 'allowRuntimeChangesInChat' = 'true'::jsonb THEN 'settings' ELSE 'talk' END
  ),
  "configRevision" = "configRevision" + 1
WHERE "runtimeOverrides" -> 'chatActions' IS NULL
  OR "runtimeOverrides" -> 'allowRuntimeChangesInChat' IS NOT NULL;
