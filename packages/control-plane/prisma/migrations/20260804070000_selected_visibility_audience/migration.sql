-- Selected visibility is a complete, non-empty current-member audience. Fold
-- the former resource owner into that audience before removing the redundant
-- ownership column. Creator attribution remains unchanged and audit-only.

UPDATE "public"."agent" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT raw.user_id, MIN(raw.ordinality) AS first_ordinal
    FROM unnest(
      CASE
        WHEN resource."ownerUserId" IS NULL THEN COALESCE(resource."sharedWith", ARRAY[]::TEXT[])
        ELSE array_prepend(resource."ownerUserId", array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), resource."ownerUserId"))
      END
    ) WITH ORDINALITY AS raw(user_id, ordinality)
    JOIN "public"."membership" AS member
      ON member."orgId" = resource."orgId"
     AND member."userId" = raw.user_id
    GROUP BY raw.user_id
  ) AS candidate
);

UPDATE "public"."daemon" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT raw.user_id, MIN(raw.ordinality) AS first_ordinal
    FROM unnest(
      CASE
        WHEN resource."ownerUserId" IS NULL THEN COALESCE(resource."sharedWith", ARRAY[]::TEXT[])
        ELSE array_prepend(resource."ownerUserId", array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), resource."ownerUserId"))
      END
    ) WITH ORDINALITY AS raw(user_id, ordinality)
    JOIN "public"."membership" AS member
      ON member."orgId" = resource."orgId"
     AND member."userId" = raw.user_id
    GROUP BY raw.user_id
  ) AS candidate
);

UPDATE "public"."cron_def" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT raw.user_id, MIN(raw.ordinality) AS first_ordinal
    FROM unnest(
      CASE
        WHEN resource."ownerUserId" IS NULL THEN COALESCE(resource."sharedWith", ARRAY[]::TEXT[])
        ELSE array_prepend(resource."ownerUserId", array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), resource."ownerUserId"))
      END
    ) WITH ORDINALITY AS raw(user_id, ordinality)
    JOIN "public"."membership" AS member
      ON member."orgId" = resource."orgId"
     AND member."userId" = raw.user_id
    GROUP BY raw.user_id
  ) AS candidate
);

UPDATE "public"."mcp_provider" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT raw.user_id, MIN(raw.ordinality) AS first_ordinal
    FROM unnest(
      CASE
        WHEN resource."ownerUserId" IS NULL THEN COALESCE(resource."sharedWith", ARRAY[]::TEXT[])
        ELSE array_prepend(resource."ownerUserId", array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), resource."ownerUserId"))
      END
    ) WITH ORDINALITY AS raw(user_id, ordinality)
    JOIN "public"."membership" AS member
      ON member."orgId" = resource."orgId"
     AND member."userId" = raw.user_id
    GROUP BY raw.user_id
  ) AS candidate
);

UPDATE "public"."skill_source" AS resource
SET "sharedWith" = (
  SELECT COALESCE(array_agg(candidate.user_id ORDER BY candidate.first_ordinal), ARRAY[]::TEXT[])
  FROM (
    SELECT raw.user_id, MIN(raw.ordinality) AS first_ordinal
    FROM unnest(
      CASE
        WHEN resource."ownerUserId" IS NULL THEN COALESCE(resource."sharedWith", ARRAY[]::TEXT[])
        ELSE array_prepend(resource."ownerUserId", array_remove(COALESCE(resource."sharedWith", ARRAY[]::TEXT[]), resource."ownerUserId"))
      END
    ) WITH ORDINALITY AS raw(user_id, ordinality)
    JOIN "public"."membership" AS member
      ON member."orgId" = resource."orgId"
     AND member."userId" = raw.user_id
    GROUP BY raw.user_id
  ) AS candidate
);

-- A legacy restricted row without a current audience receives one deterministic
-- current member. Prefer an organization owner, then the longest-standing member.
UPDATE "public"."agent" AS resource
SET "sharedWith" = ARRAY(
  SELECT member."userId"
  FROM "public"."membership" AS member
  WHERE member."orgId" = resource."orgId"
  ORDER BY CASE member."role" WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END,
           member."createdAt",
           member."userId"
  LIMIT 1
)
WHERE resource."visibility" = 'restricted' AND cardinality(resource."sharedWith") = 0;

UPDATE "public"."daemon" AS resource
SET "sharedWith" = ARRAY(
  SELECT member."userId"
  FROM "public"."membership" AS member
  WHERE member."orgId" = resource."orgId"
  ORDER BY CASE member."role" WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END,
           member."createdAt",
           member."userId"
  LIMIT 1
)
WHERE resource."visibility" = 'restricted' AND cardinality(resource."sharedWith") = 0;

UPDATE "public"."cron_def" AS resource
SET "sharedWith" = ARRAY(
  SELECT member."userId"
  FROM "public"."membership" AS member
  WHERE member."orgId" = resource."orgId"
  ORDER BY CASE member."role" WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END,
           member."createdAt",
           member."userId"
  LIMIT 1
)
WHERE resource."visibility" = 'restricted' AND cardinality(resource."sharedWith") = 0;

UPDATE "public"."mcp_provider" AS resource
SET "sharedWith" = ARRAY(
  SELECT member."userId"
  FROM "public"."membership" AS member
  WHERE member."orgId" = resource."orgId"
  ORDER BY CASE member."role" WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END,
           member."createdAt",
           member."userId"
  LIMIT 1
)
WHERE resource."visibility" = 'restricted' AND cardinality(resource."sharedWith") = 0;

UPDATE "public"."skill_source" AS resource
SET "sharedWith" = ARRAY(
  SELECT member."userId"
  FROM "public"."membership" AS member
  WHERE member."orgId" = resource."orgId"
  ORDER BY CASE member."role" WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END,
           member."createdAt",
           member."userId"
  LIMIT 1
)
WHERE resource."visibility" = 'restricted' AND cardinality(resource."sharedWith") = 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."agent" WHERE "visibility" = 'restricted' AND cardinality("sharedWith") = 0
    UNION ALL
    SELECT 1 FROM "public"."daemon" WHERE "visibility" = 'restricted' AND cardinality("sharedWith") = 0
    UNION ALL
    SELECT 1 FROM "public"."cron_def" WHERE "visibility" = 'restricted' AND cardinality("sharedWith") = 0
    UNION ALL
    SELECT 1 FROM "public"."mcp_provider" WHERE "visibility" = 'restricted' AND cardinality("sharedWith") = 0
    UNION ALL
    SELECT 1 FROM "public"."skill_source" WHERE "visibility" = 'restricted' AND cardinality("sharedWith") = 0
  ) THEN
    RAISE EXCEPTION 'cannot migrate a Selected resource without a current organization member';
  END IF;
END $$;

ALTER TABLE "public"."agent"
  ADD CONSTRAINT "agent_selected_audience_nonempty"
  CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0);
ALTER TABLE "public"."daemon"
  ADD CONSTRAINT "daemon_selected_audience_nonempty"
  CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0);
ALTER TABLE "public"."cron_def"
  ADD CONSTRAINT "cron_def_selected_audience_nonempty"
  CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0);
ALTER TABLE "public"."mcp_provider"
  ADD CONSTRAINT "mcp_provider_selected_audience_nonempty"
  CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0);
ALTER TABLE "public"."skill_source"
  ADD CONSTRAINT "skill_source_selected_audience_nonempty"
  CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0);

ALTER TABLE "public"."agent" DROP CONSTRAINT "agent_ownerUserId_fkey";
ALTER TABLE "public"."daemon" DROP CONSTRAINT "daemon_ownerUserId_fkey";
ALTER TABLE "public"."cron_def" DROP CONSTRAINT "cron_def_ownerUserId_fkey";
ALTER TABLE "public"."mcp_provider" DROP CONSTRAINT "mcp_provider_ownerUserId_fkey";
ALTER TABLE "public"."skill_source" DROP CONSTRAINT "skill_source_ownerUserId_fkey";

DROP INDEX "public"."agent_orgId_ownerUserId_idx";
DROP INDEX "public"."daemon_orgId_ownerUserId_idx";
DROP INDEX "public"."cron_def_orgId_ownerUserId_idx";
DROP INDEX "public"."mcp_provider_orgId_ownerUserId_idx";
DROP INDEX "public"."skill_source_orgId_ownerUserId_idx";

ALTER TABLE "public"."agent" DROP COLUMN "ownerUserId";
ALTER TABLE "public"."daemon" DROP COLUMN "ownerUserId";
ALTER TABLE "public"."cron_def" DROP COLUMN "ownerUserId";
ALTER TABLE "public"."mcp_provider" DROP COLUMN "ownerUserId";
ALTER TABLE "public"."skill_source" DROP COLUMN "ownerUserId";
