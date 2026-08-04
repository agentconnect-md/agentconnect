ALTER TABLE "session_spend"
  ADD COLUMN "model" TEXT,
  ADD COLUMN "cumulativeTotalTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeInputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeOutputTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeThoughtTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeCachedReadTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cumulativeCachedWriteTokens" INTEGER NOT NULL DEFAULT 0;

-- Existing timelines predate model observations. Attribute their last known
-- cumulative token snapshot to the honest unknown bucket; later reports diff
-- from this baseline and can be attributed to their observed model without
-- rewriting pre-upgrade usage.
WITH latest AS (
  SELECT DISTINCT ON ("agentId", "sessionId")
    "agentId", "sessionId", "at"
  FROM "session_spend"
  ORDER BY "agentId", "sessionId", "at" DESC
)
UPDATE "session_spend" AS sp
SET
  "cumulativeTotalTokens" = u."totalTokens",
  "cumulativeInputTokens" = u."inputTokens",
  "cumulativeOutputTokens" = u."outputTokens",
  "cumulativeThoughtTokens" = u."thoughtTokens",
  "cumulativeCachedReadTokens" = u."cachedReadTokens",
  "cumulativeCachedWriteTokens" = u."cachedWriteTokens"
FROM latest l
JOIN "session_usage" u
  ON u."agentId" = l."agentId" AND u."sessionId" = l."sessionId"
WHERE sp."agentId" = l."agentId"
  AND sp."sessionId" = l."sessionId"
  AND sp."at" = l."at";

-- Defensive baseline for a historical snapshot whose spend sample is missing.
INSERT INTO "session_spend" (
  "agentId", "sessionId", "at", "cumulativeCost",
  "cumulativeTotalTokens", "cumulativeInputTokens", "cumulativeOutputTokens",
  "cumulativeThoughtTokens", "cumulativeCachedReadTokens", "cumulativeCachedWriteTokens"
)
SELECT
  u."agentId", u."sessionId", u."lastActivityAt", u."costAmount",
  u."totalTokens", u."inputTokens", u."outputTokens",
  u."thoughtTokens", u."cachedReadTokens", u."cachedWriteTokens"
FROM "session_usage" u
WHERE NOT EXISTS (
  SELECT 1 FROM "session_spend" sp
  WHERE sp."agentId" = u."agentId" AND sp."sessionId" = u."sessionId"
);
