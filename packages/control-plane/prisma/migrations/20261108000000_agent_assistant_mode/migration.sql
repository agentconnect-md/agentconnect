-- The per-agent assistant mode policy (assistant-mode.md §5.1): protocol `AssistantModePolicy`, null when never configured.
ALTER TABLE "agent" ADD COLUMN "assistantMode" JSONB;
