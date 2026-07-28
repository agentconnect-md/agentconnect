-- Slack multi-person DMs get their own conversation kind: reported on observation
-- like an `im` (Slack never lists them as bot membership), but mention-gated like a
-- channel. Additive — existing rows keep their kind.
ALTER TYPE "ConversationKind" ADD VALUE IF NOT EXISTS 'mpim';
