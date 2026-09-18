-- The preset's skill roster follows the source repo's head, not a CP constant
-- (docs/designs/preset-agents.md §3.1): `agentconnect-md/agentconnect-skill@main` IS the
-- list, so publishing a skill there reaches every install without a release. Orgs born
-- before this carry the two-name filter the constant used to pin; widen them so new and
-- existing orgs resolve to the same roster.
--
-- Deliberately unconditional on the stored filter: a narrowed one is replaced, because a
-- uniform head-following roster is the point. Scoped by the preset source's numeric repo
-- identity, so a differently-sourced row that happens to share the name is never touched.
--
-- Order matters: the agent rewrite reads the source row, so it runs before the widening.

-- The preset agents' enable-list: the whole source, in place of the two pinned refs.
-- Entries from other sources keep their order; an already-widened list is left alone.
UPDATE "agent" AS a
SET "runtimeOverrides" = jsonb_set(
      COALESCE(a."runtimeOverrides", '{}'::jsonb),
      '{skills}',
      COALESCE(
        (
          SELECT jsonb_agg(entry ORDER BY ord)
          FROM jsonb_array_elements(a."runtimeOverrides" -> 'skills') WITH ORDINALITY AS t(entry, ord)
          WHERE split_part(entry #>> '{}', '/', 1) <> 'agentconnect'
        ),
        '[]'::jsonb
      ) || '["agentconnect/*"]'::jsonb,
      true
    )
FROM "preset_agent" AS p, "skill_source" AS s
WHERE p."agentId" = a."id"
  AND p."preset" = 'general'
  AND p."status" = 'created'
  AND s."orgId" = a."orgId"
  AND s."name" = 'agentconnect'
  AND s."githubRepoId" = 1322557433
  AND jsonb_typeof(a."runtimeOverrides" -> 'skills') = 'array'
  AND NOT a."runtimeOverrides" -> 'skills' @> '["agentconnect/*"]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(a."runtimeOverrides" -> 'skills') AS e
    WHERE split_part(e #>> '{}', '/', 1) = 'agentconnect'
  );

-- The source's own filter: empty ⇒ install every skill the directory exposes.
UPDATE "skill_source"
SET "skills" = '{}'::text[]
WHERE "name" = 'agentconnect'
  AND "githubRepoId" = 1322557433
  AND "skills" <> '{}'::text[];
