-- Session-targeted webchat conversations (webchat-cross-integration-continuation.md).
-- A non-null targetSessionId marks a conversation that continues an existing
-- integration-origin session; existing rows need no backfill (null = ordinary).
ALTER TABLE "public"."webchat_conversation" ADD COLUMN "targetSessionId" TEXT;

-- Cascade: a targeted conversation without its target has no purpose.
ALTER TABLE "public"."webchat_conversation"
  ADD CONSTRAINT "webchat_conversation_targetSessionId_fkey"
  FOREIGN KEY ("targetSessionId") REFERENCES "public"."session_meta"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Concurrent mints for one user/session converge on one browser conversation
-- (Postgres permits unlimited NULL targets, so standard rows are unconstrained).
CREATE UNIQUE INDEX "webchat_conversation_userId_targetSessionId_key"
  ON "public"."webchat_conversation"("userId", "targetSessionId");

-- Relay feature advertisement (rc/register.features), refreshed on every register.
ALTER TABLE "public"."relay" ADD COLUMN "features" TEXT[] NOT NULL DEFAULT '{}';
