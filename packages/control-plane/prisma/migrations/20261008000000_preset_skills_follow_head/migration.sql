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
--
-- Explicitly wrapped: Prisma 7 does NOT run a `migrate deploy` file in a transaction (verified
-- against 7.9 — a statement after a failing one leaves the earlier ones committed). Without
-- BEGIN/COMMIT a CP serving `register/ok` mid-migration could hand a daemon the widened skills
-- at its pre-bump revision, which the daemon refuses as equal-revision/different-digest until
-- the next push; the wrap removes that window rather than leaving it to self-heal.
BEGIN;

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

-- The fence both rewrites above would otherwise skip. `AgentSpec.skills` is RESOLVED from
-- these rows, so changing either one changes spec content without touching the agent's
-- `configRevision` — and the daemon persists the greatest applied revision to disk and
-- refuses an equal revision carrying a different digest, so an affected agent would reject
-- the migrated spec on every reconnect, permanently, until an unrelated edit bumped it.
-- The repo path does this through `bumpAgentsReferencingSkillSource`; mirror its predicate
-- exactly, over-approximation included (every agent in the org whose enable-list names the
-- source, not only those whose resolved content moved): a spurious bump costs one identical
-- re-apply, a missing one wedges the agent. Inside this file's explicit transaction, so no reader
-- observes new content at an old revision.
UPDATE "agent" AS a
SET "configRevision" = a."configRevision" + 1
FROM "skill_source" AS s
WHERE s."orgId" = a."orgId"
  AND s."name" = 'agentconnect'
  AND s."githubRepoId" = 1322557433
  AND jsonb_typeof(a."runtimeOverrides" -> 'skills') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(a."runtimeOverrides" -> 'skills') AS e
    WHERE split_part(e #>> '{}', '/', 1) = 'agentconnect'
  );

COMMIT;
