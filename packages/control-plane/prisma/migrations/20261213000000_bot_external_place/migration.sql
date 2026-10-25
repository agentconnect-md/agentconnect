-- A bot's detected external places outlive its integrations, so a reused bot seeds them Off (resource-visibility.md §14.9).
CREATE TABLE "bot_external_place" (
    "botId" UUID NOT NULL,
    "channelId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "name" TEXT,
    "kind" "ConversationKind" NOT NULL DEFAULT 'channel',
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bot_external_place_pkey" PRIMARY KEY ("botId","channelId")
);

ALTER TABLE "bot_external_place" ADD CONSTRAINT "bot_external_place_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the rows that already carry a detection, a sticky reason first.
INSERT INTO "bot_external_place" ("botId", "channelId", "reason", "name", "kind", "updatedAt")
SELECT DISTINCT ON (i."botId", ic."channelId")
    i."botId", ic."channelId", ic."externalReason", ic."name", ic."kind", NOW()
FROM "integration_channel" ic
JOIN "integration" i ON i."id" = ic."integrationId"
WHERE ic."externalReason" IS NOT NULL
ORDER BY i."botId", ic."channelId", (ic."externalReason" = 'externallyShared'), ic."updatedAt" DESC;
