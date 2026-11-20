-- Mail lists no conversations: each sender is admitted by the member question, so a row would gate nothing and only list who wrote.
DELETE FROM "integration_channel"
 WHERE "integrationId" IN (SELECT "id" FROM "integration" WHERE "platform" = 'email');
