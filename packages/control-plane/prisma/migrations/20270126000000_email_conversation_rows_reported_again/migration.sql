-- Mail lists no conversations; daemons from before that rule re-reported cached rows after the first cleanup, so they go again.
DELETE FROM "integration_channel"
 WHERE "integrationId" IN (SELECT "id" FROM "integration" WHERE "platform" = 'email');
