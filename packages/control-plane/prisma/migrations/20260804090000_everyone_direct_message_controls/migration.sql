-- Direct conversations are now visible and configurable for org-visible agents.
-- Existing rows were forced Off while they were hidden/inert; seed them to the
-- same defaults newly observed conversations receive (1:1 DM On, group DM Mention).
UPDATE "integration_channel" AS ic
SET
  "trigger" = CASE
    WHEN ic."kind" = 'im'::"ConversationKind" THEN 'any'::"ChannelTrigger"
    ELSE 'mention'::"ChannelTrigger"
  END,
  "updatedAt" = NOW()
FROM "integration" AS i
JOIN "agent" AS a ON a."id" = i."agentId"
WHERE ic."integrationId" = i."id"
  AND a."visibility" = 'org'::"ResourceVisibility"
  AND ic."kind" IN ('im'::"ConversationKind", 'mpim'::"ConversationKind")
  AND ic."trigger" = 'off'::"ChannelTrigger";
