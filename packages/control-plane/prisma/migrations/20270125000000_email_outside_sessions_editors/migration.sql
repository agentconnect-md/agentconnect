-- An address that kept the old default, outside senders' sessions private to the member who added it, takes the new one: the agent's editors (email-integration.md §4.1).
UPDATE "bot" b
   SET "platformConfig" = jsonb_set(b."platformConfig", '{outsideSessions}', '"editors"'::jsonb)
 WHERE b."platform" = 'email'
   AND EXISTS (
     SELECT 1 FROM "integration" i
      WHERE i."botId" = b."id"
        AND i."createdByUserId" IS NOT NULL
        AND b."platformConfig"->>'outsideSessions' = 'user:' || i."createdByUserId"
   );
