-- Patrols are follow-up checks (assistant-mode.md §5.12): the budget limit and the check coordinate take the new names.
UPDATE "agent"
SET "assistantMode" = jsonb_set(
  "assistantMode" #- '{limits,dailyPatrolBudget}',
  '{limits,dailyCheckBudget}',
  "assistantMode" -> 'limits' -> 'dailyPatrolBudget'
)
WHERE "assistantMode" -> 'limits' ? 'dailyPatrolBudget';

UPDATE "session_meta"
SET "thread" = replace("thread", 'subsession:patrol-', 'subsession:check-')
WHERE "thread" LIKE 'subsession:patrol-%';

-- A hint is observed again on the check's next run.
DELETE FROM "session_executor_hint" WHERE "sessionKey" LIKE '%subsession:patrol-%';
