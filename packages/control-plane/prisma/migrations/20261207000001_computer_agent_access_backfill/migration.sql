-- Moves the two-sided grant onto the Computer's agent access (computer-use.md §4.1); idempotent, it converts only the old shapes.
-- A converted agent's revision moves: its emitted spec changes, and a daemon refuses an equal revision whose digest differs.

-- The agents an old policy granted get the Computer on their derived list.
UPDATE "agent"
SET "configRevision" = "configRevision" + 1
WHERE "id"::text IN (
  SELECT jsonb_array_elements_text("policy" -> 'allowedAgents')
  FROM "computer"
  WHERE jsonb_typeof("policy") = 'object' AND jsonb_typeof("policy" -> 'allowedAgents') = 'array'
    AND "status" <> 'revoked' AND ("allocation" IS NULL OR "allocation" = 'manual')
);

-- The policy's allowed agents become the Selected agents; an empty or unreadable list becomes none.
UPDATE "computer" AS c
SET "accessAgentIds" = granted.ids,
    "agentAccess" = CASE WHEN cardinality(granted.ids) > 0 THEN 'selected'::"ComputerAgentAccess" ELSE 'none'::"ComputerAgentAccess" END
FROM (
  SELECT "id",
         ARRAY(
           SELECT DISTINCT e
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof("policy" -> 'allowedAgents') = 'array' THEN "policy" -> 'allowedAgents' ELSE '[]'::jsonb END
           ) AS e
         ) AS ids
  FROM "computer"
  WHERE jsonb_typeof("policy") = 'object' AND "policy" ? 'allowedAgents'
) AS granted
WHERE granted."id" = c."id";

-- A per-agent or ephemeral computer is implicitly Selected for the one agent it was made for.
UPDATE "computer"
SET "agentAccess" = 'selected', "accessAgentIds" = ARRAY["ownerAgentId"::TEXT]
WHERE "allocation" IN ('per-agent', 'ephemeral') AND "ownerAgentId" IS NOT NULL;

UPDATE "computer" SET "policy" = "policy" - 'allowedAgents' WHERE jsonb_typeof("policy") = 'object' AND "policy" ? 'allowedAgents';

-- An agent keeps only its managed mode, and only while its old switch was on; its Computer list is now derived.
UPDATE "agent"
SET "configRevision" = "configRevision" + 1,
  "runtimeOverrides" = CASE
  WHEN "runtimeOverrides" -> 'computerUse' ->> 'enabled' = 'true'
       AND jsonb_typeof("runtimeOverrides" -> 'computerUse' -> 'managed') = 'object'
    THEN jsonb_set("runtimeOverrides", '{computerUse}', jsonb_build_object('managed', "runtimeOverrides" -> 'computerUse' -> 'managed'))
  ELSE "runtimeOverrides" - 'computerUse'
END
WHERE jsonb_typeof("runtimeOverrides") = 'object'
  AND "runtimeOverrides" ? 'computerUse'
  AND (
    jsonb_typeof("runtimeOverrides" -> 'computerUse') <> 'object'
    OR ("runtimeOverrides" -> 'computerUse') ?| ARRAY['enabled', 'computers']
  );
