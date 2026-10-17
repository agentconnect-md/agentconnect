-- The first switch-on of assistant mode (assistant-mode.md §5.15): written once by the agent update that turns the mode on.
ALTER TABLE "agent" ADD COLUMN "assistantOnboarding" JSONB;
