-- Contract step (assistant-mode.md §5.1): drop the two routing keys a Control Plane before v2.4.0 stored on the policy.
UPDATE "agent"
SET "assistantMode" = "assistantMode" - 'responsibleUserId' - 'fallbackConversation'
WHERE "assistantMode" ?| ARRAY['responsibleUserId', 'fallbackConversation'];
