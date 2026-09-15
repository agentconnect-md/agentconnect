-- The console no longer offers the issues "labeled" cadence: a github issues row
-- that fired on `issues:labeled` alone moves to the any-update form and keeps its
-- label filter, so applying a matching label still enters the thread and its
-- follow-ups run (webhook-triggers-and-github-events.md). The compiled definition
-- changes, so the relay must be pushed again. Idempotent: a converted row no
-- longer matches the predicate.
UPDATE "hook_def"
SET "events" = ARRAY['issues:*', 'issue_comment:created'],
    "commentFamilies" = ARRAY['issues'],
    "configRevision" = "configRevision" + 1,
    "lastModifiedAt" = now()
WHERE "kind" = 'github'
  AND "family" = 'issues'
  AND "events" = ARRAY['issues:labeled'];
