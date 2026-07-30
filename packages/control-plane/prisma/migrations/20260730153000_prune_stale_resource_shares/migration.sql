-- Older member-removal code did not prune SkillSource at all, and concurrent
-- resource writes could leave stale ids in the other four arrays. Because
-- app_user.id is stable across removal and re-invite, keep only current members
-- now and de-duplicate each array while preserving its first-seen order.
BEGIN;

UPDATE "public"."agent" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(valid.user_id ORDER BY valid.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
    FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
      WITH ORDINALITY AS shared(user_id, ordinality)
    WHERE EXISTS (
      SELECT 1 FROM "public"."membership" AS member
      WHERE member."orgId" = resource."orgId"
        AND member."userId" = shared.user_id
    )
    GROUP BY shared.user_id
  ) AS valid
)
WHERE resource."sharedWith" IS NULL
   OR EXISTS (
     SELECT 1
     FROM unnest(resource."sharedWith") AS shared(user_id)
     LEFT JOIN "public"."membership" AS member
       ON member."orgId" = resource."orgId"
      AND member."userId" = shared.user_id
     GROUP BY shared.user_id
     HAVING COUNT(*) > 1 OR COUNT(member."userId") = 0
   );

UPDATE "public"."daemon" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(valid.user_id ORDER BY valid.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
    FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
      WITH ORDINALITY AS shared(user_id, ordinality)
    WHERE EXISTS (
      SELECT 1 FROM "public"."membership" AS member
      WHERE member."orgId" = resource."orgId"
        AND member."userId" = shared.user_id
    )
    GROUP BY shared.user_id
  ) AS valid
)
WHERE resource."sharedWith" IS NULL
   OR EXISTS (
     SELECT 1
     FROM unnest(resource."sharedWith") AS shared(user_id)
     LEFT JOIN "public"."membership" AS member
       ON member."orgId" = resource."orgId"
      AND member."userId" = shared.user_id
     GROUP BY shared.user_id
     HAVING COUNT(*) > 1 OR COUNT(member."userId") = 0
   );

UPDATE "public"."cron_def" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(valid.user_id ORDER BY valid.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
    FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
      WITH ORDINALITY AS shared(user_id, ordinality)
    WHERE EXISTS (
      SELECT 1 FROM "public"."membership" AS member
      WHERE member."orgId" = resource."orgId"
        AND member."userId" = shared.user_id
    )
    GROUP BY shared.user_id
  ) AS valid
)
WHERE resource."sharedWith" IS NULL
   OR EXISTS (
     SELECT 1
     FROM unnest(resource."sharedWith") AS shared(user_id)
     LEFT JOIN "public"."membership" AS member
       ON member."orgId" = resource."orgId"
      AND member."userId" = shared.user_id
     GROUP BY shared.user_id
     HAVING COUNT(*) > 1 OR COUNT(member."userId") = 0
   );

UPDATE "public"."mcp_provider" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(valid.user_id ORDER BY valid.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
    FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
      WITH ORDINALITY AS shared(user_id, ordinality)
    WHERE EXISTS (
      SELECT 1 FROM "public"."membership" AS member
      WHERE member."orgId" = resource."orgId"
        AND member."userId" = shared.user_id
    )
    GROUP BY shared.user_id
  ) AS valid
)
WHERE resource."sharedWith" IS NULL
   OR EXISTS (
     SELECT 1
     FROM unnest(resource."sharedWith") AS shared(user_id)
     LEFT JOIN "public"."membership" AS member
       ON member."orgId" = resource."orgId"
      AND member."userId" = shared.user_id
     GROUP BY shared.user_id
     HAVING COUNT(*) > 1 OR COUNT(member."userId") = 0
   );

UPDATE "public"."skill_source" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(valid.user_id ORDER BY valid.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT shared.user_id, MIN(shared.ordinality) AS first_ordinal
    FROM unnest(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]))
      WITH ORDINALITY AS shared(user_id, ordinality)
    WHERE EXISTS (
      SELECT 1 FROM "public"."membership" AS member
      WHERE member."orgId" = resource."orgId"
        AND member."userId" = shared.user_id
    )
    GROUP BY shared.user_id
  ) AS valid
)
WHERE resource."sharedWith" IS NULL
   OR EXISTS (
     SELECT 1
     FROM unnest(resource."sharedWith") AS shared(user_id)
     LEFT JOIN "public"."membership" AS member
       ON member."orgId" = resource."orgId"
      AND member."userId" = shared.user_id
     GROUP BY shared.user_id
     HAVING COUNT(*) > 1 OR COUNT(member."userId") = 0
   );

COMMIT;
