-- Assistant mode derives its responsible user and has no fallback conversation (assistant-mode.md §5.1), so the stored choices go.
-- A moved row's revision bumps, because a daemon refuses an equal revision whose digest differs.
UPDATE "agent"
SET
  "assistantMode" = "assistantMode" - 'responsibleUserId' - 'fallbackConversation',
  "configRevision" = "configRevision" + 1
WHERE "assistantMode" ?| ARRAY['responsibleUserId', 'fallbackConversation'];
