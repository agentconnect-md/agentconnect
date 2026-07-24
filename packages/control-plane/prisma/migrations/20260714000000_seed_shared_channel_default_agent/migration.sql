-- Backfill: seed each HTTP shared-bot channel that has no owning agent with the
-- bot's CREATING (earliest active install) agent, so it routes to that agent out of
-- the box instead of "No default" (shared-bot-relay.md §10.1). One-time — new
-- channels are seeded going forward by SharedBotOrchestrator.replaceChannels.
--
-- Preserves the one-owner-per-channel invariant: only the creating install's row is
-- set, and only when no OTHER install of the bot already owns the channel (an
-- operator-assigned non-creating owner is left untouched). Scoped to transport=http
-- because per-channel ownership only drives routing for shared (relay) bots.
WITH creating AS (
    SELECT DISTINCT ON (i."botId")
        i."botId"   AS bot_id,
        i."id"      AS integration_id,
        i."agentId" AS agent_id
    FROM "integration" i
    JOIN "bot" b ON b."id" = i."botId"
    WHERE i."status" = 'active' AND b."transport" = 'http'
    ORDER BY i."botId", i."createdAt" ASC
),
owned AS (
    SELECT DISTINCT i."botId" AS bot_id, ic."channelId" AS channel_id
    FROM "integration_channel" ic
    JOIN "integration" i ON i."id" = ic."integrationId"
    WHERE ic."agentId" IS NOT NULL
)
UPDATE "integration_channel" ic
SET "agentId" = c.agent_id, "updatedAt" = now()
FROM creating c
WHERE ic."integrationId" = c.integration_id
  AND ic."agentId" IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM owned o
      WHERE o.bot_id = c.bot_id AND o.channel_id = ic."channelId"
  );
