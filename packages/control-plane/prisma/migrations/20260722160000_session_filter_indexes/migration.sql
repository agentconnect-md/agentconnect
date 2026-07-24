-- Session list pagination is ordered entirely from session_meta. Older rows can
-- lack the activity timestamp, so preserve the former usage fallback before
-- making the ordering key mandatory.
UPDATE "session_meta" AS sm
SET "lastActivityAt" = COALESCE(
  (
    SELECT su."lastActivityAt"
    FROM "session_usage" AS su
    WHERE su."agentId" = sm."agentId"
      AND su."sessionId" = sm."id"
  ),
  sm."startedAt"
)
WHERE sm."lastActivityAt" IS NULL;

ALTER TABLE "session_meta"
  ALTER COLUMN "lastActivityAt" TYPE TIMESTAMPTZ(3)
    USING date_trunc('milliseconds', "lastActivityAt"),
  ALTER COLUMN "startedAt" TYPE TIMESTAMPTZ(3)
    USING date_trunc('milliseconds', "startedAt"),
  ALTER COLUMN "lastActivityAt" SET NOT NULL;

-- Replace the short activity index with keyset-pagination and filter indexes.
DROP INDEX "session_meta_agentId_lastActivityAt_idx";

CREATE INDEX "session_meta_activity_page_idx"
  ON "session_meta"(
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC,
    "agentId"
  );

CREATE INDEX "session_meta_agent_activity_page_idx"
  ON "session_meta"(
    "agentId",
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC
  );

CREATE INDEX "session_meta_agent_platform_page_idx"
  ON "session_meta"(
    "agentId",
    "platform",
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC
  );

CREATE INDEX "session_meta_agent_channel_page_idx"
  ON "session_meta"(
    "agentId",
    "channel",
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC
  );

CREATE INDEX "session_meta_agent_trigger_page_idx"
  ON "session_meta"(
    "agentId",
    "triggeredBy",
    "lastActivityAt" DESC,
    "startedAt" DESC,
    "id" DESC
  );
