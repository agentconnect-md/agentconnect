-- Split a code-host hook into one row per (agent, repo, subject family) so each
-- family carries its own cadence and its own mention gate
-- (webhook-triggers-and-github-events.md). Written idempotently: re-executing
-- the file is a no-op, because the backfill only visits family-less rows.

-- AlterTable
ALTER TABLE "hook_def" ADD COLUMN IF NOT EXISTS "family" TEXT;

-- Backfill: give every legacy github/gitlab row a family, keeping the
-- review-capable family on the EXISTING id (projections, review leases and run
-- history all key on it) and inserting a sibling row for every other family the
-- old row's subscriptions covered.
DO $$
DECLARE
  hook RECORD;
  pattern TEXT;
  prefix TEXT;
  fams TEXT[];
  ordered TEXT[];
  candidate TEXT;
  primary_family TEXT;
  has_issue_comment BOOLEAN;
  row_events TEXT[];
  row_comments TEXT[];
BEGIN
  FOR hook IN
    SELECT * FROM "hook_def"
    WHERE "kind" IN ('github', 'gitlab') AND "family" IS NULL
    ORDER BY "createdAt", "id"
  LOOP
    fams := ARRAY[]::TEXT[];
    has_issue_comment := FALSE;
    -- The subject each stored pattern names. GitHub's issue_comment covers both
    -- thread families, so on its own it names none.
    FOREACH pattern IN ARRAY COALESCE(hook."events", ARRAY[]::TEXT[]) LOOP
      prefix := split_part(pattern, ':', 1);
      IF prefix = 'issue_comment' THEN
        has_issue_comment := TRUE;
      ELSIF prefix = 'pull_request_review_comment' THEN
        fams := fams || 'pull_request';
      ELSIF prefix IN ('issues', 'pull_request', 'merge_request', 'push') THEN
        fams := fams || prefix;
      END IF;
    END LOOP;
    IF hook."kind" = 'gitlab' THEN
      -- GitLab's commentFamilies IS the note subscription, so it names subjects.
      fams := fams || COALESCE(hook."commentFamilies", ARRAY[]::TEXT[]);
    ELSIF has_issue_comment THEN
      IF COALESCE(cardinality(hook."commentFamilies"), 0) > 0 THEN
        fams := fams || ARRAY(
          SELECT f FROM unnest(hook."commentFamilies") AS f WHERE f IN ('issues', 'pull_request')
        );
      ELSIF cardinality(fams) = 0 THEN
        -- A comment-only repo-wide rule covered both thread families.
        fams := ARRAY['issues', 'pull_request'];
      END IF;
      -- Otherwise legacy repo-wide comments are deliberately narrowed to the
      -- families this row already subscribed to (accepted behavior change).
    END IF;
    -- Preference order: a review-capable family always keeps the existing id.
    ordered := ARRAY(
      SELECT f FROM unnest(ARRAY['pull_request', 'merge_request', 'issues', 'push']) AS f
      WHERE f = ANY(fams)
    );
    IF cardinality(ordered) = 0 THEN
      -- A row that subscribes to nothing still needs a family to stay editable.
      ordered := ARRAY[CASE WHEN hook."kind" = 'gitlab' THEN 'merge_request' ELSE 'pull_request' END];
    END IF;

    -- Duplicate legacy rows on one (agent, kind, repo) predate the split, so
    -- claim only free slots; a row left with a NULL family stays legacy-inert.
    primary_family := NULL;
    FOREACH candidate IN ARRAY ordered LOOP
      IF NOT EXISTS (
        SELECT 1 FROM "hook_def" x
        WHERE x."id" <> hook."id"
          AND x."agentId" IS NOT DISTINCT FROM hook."agentId"
          AND x."kind" = hook."kind"
          AND x."repoId" IS NOT DISTINCT FROM hook."repoId"
          AND x."family" = candidate
      ) THEN
        primary_family := candidate;
        EXIT;
      END IF;
    END LOOP;
    CONTINUE WHEN primary_family IS NULL;

    row_events := ARRAY(
      SELECT e FROM unnest(COALESCE(hook."events", ARRAY[]::TEXT[])) AS e
      WHERE split_part(e, ':', 1) = primary_family
        OR (hook."kind" = 'github' AND split_part(e, ':', 1) = 'pull_request_review_comment'
            AND primary_family = 'pull_request')
        OR (hook."kind" = 'github' AND split_part(e, ':', 1) = 'issue_comment'
            AND primary_family IN ('issues', 'pull_request')
            AND (COALESCE(cardinality(hook."commentFamilies"), 0) = 0
                 OR primary_family = ANY(hook."commentFamilies")))
    );
    IF hook."kind" = 'github' THEN
      row_comments := CASE
        WHEN EXISTS (SELECT 1 FROM unnest(row_events) AS e WHERE split_part(e, ':', 1) = 'issue_comment')
        THEN ARRAY[primary_family] ELSE ARRAY[]::TEXT[] END;
    ELSE
      row_comments := CASE
        WHEN primary_family = ANY(COALESCE(hook."commentFamilies", ARRAY[]::TEXT[]))
        THEN ARRAY[primary_family] ELSE ARRAY[]::TEXT[] END;
    END IF;
    -- A narrowed subscription is a new compiled definition, so it must be pushed.
    UPDATE "hook_def" SET
      "family" = primary_family,
      "events" = row_events,
      "commentFamilies" = row_comments,
      "configRevision" = CASE
        WHEN row_events IS DISTINCT FROM COALESCE(hook."events", ARRAY[]::TEXT[])
          OR row_comments IS DISTINCT FROM COALESCE(hook."commentFamilies", ARRAY[]::TEXT[])
        THEN "configRevision" + 1 ELSE "configRevision" END
    WHERE "id" = hook."id";

    FOREACH candidate IN ARRAY ordered LOOP
      CONTINUE WHEN candidate = primary_family;
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM "hook_def" x
        WHERE x."agentId" IS NOT DISTINCT FROM hook."agentId"
          AND x."kind" = hook."kind"
          AND x."repoId" IS NOT DISTINCT FROM hook."repoId"
          AND x."family" = candidate
      );
      row_events := ARRAY(
        SELECT e FROM unnest(COALESCE(hook."events", ARRAY[]::TEXT[])) AS e
        WHERE split_part(e, ':', 1) = candidate
          OR (hook."kind" = 'github' AND split_part(e, ':', 1) = 'pull_request_review_comment'
              AND candidate = 'pull_request')
          OR (hook."kind" = 'github' AND split_part(e, ':', 1) = 'issue_comment'
              AND candidate IN ('issues', 'pull_request')
              AND (COALESCE(cardinality(hook."commentFamilies"), 0) = 0
                   OR candidate = ANY(hook."commentFamilies")))
      );
      IF hook."kind" = 'github' THEN
        row_comments := CASE
          WHEN EXISTS (SELECT 1 FROM unnest(row_events) AS e WHERE split_part(e, ':', 1) = 'issue_comment')
          THEN ARRAY[candidate] ELSE ARRAY[]::TEXT[] END;
      ELSE
        row_comments := CASE
          WHEN candidate = ANY(COALESCE(hook."commentFamilies", ARRAY[]::TEXT[]))
          THEN ARRAY[candidate] ELSE ARRAY[]::TEXT[] END;
      END IF;
      -- A sibling is never a review family (those win the primary slot), so its
      -- review trio starts at the defaults rather than inheriting the old row's.
      INSERT INTO "hook_def" (
        "id", "orgId", "agentId", "kind", "name", "enabled", "sessionMode",
        "repoId", "repoFullName", "githubSessionKey", "family",
        "events", "commentFamilies", "labelFilter", "mentionOnly",
        "configRevision", "dispatchRevision", "projectionEpoch",
        "reviewPolicy", "reportingMode", "gateMode",
        "targetPlatform", "targetChannel", "targetIntegrationId",
        "createdByUserId", "lastModifiedByUserId", "lastModifiedAt", "createdAt", "updatedAt"
      ) VALUES (
        gen_random_uuid(), hook."orgId", hook."agentId", hook."kind", hook."name", hook."enabled", hook."sessionMode",
        hook."repoId", hook."repoFullName", hook."githubSessionKey", candidate,
        row_events, row_comments, hook."labelFilter", hook."mentionOnly",
        1, 1, 1,
        'off'::"HookReviewPolicy", 'off'::"HookReportingMode", 'informational'::"HookGateMode",
        hook."targetPlatform", hook."targetChannel", hook."targetIntegrationId",
        hook."createdByUserId", hook."lastModifiedByUserId", now(), now(), now()
      );
    END LOOP;
  END LOOP;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "hook_def_agent_repo_family_key" ON "hook_def"("agentId", "kind", "repoId", "family");
