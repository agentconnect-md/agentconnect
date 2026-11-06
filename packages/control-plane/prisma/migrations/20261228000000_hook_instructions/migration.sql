-- Owner-authored instructions a generic webhook puts ahead of each fenced delivery payload (webhook-triggers-and-github-events.md).
ALTER TABLE "hook_def" ADD COLUMN "instructions" TEXT;
