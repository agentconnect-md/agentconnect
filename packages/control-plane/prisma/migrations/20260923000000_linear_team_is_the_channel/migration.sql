-- Drop the workspace-keyed Linear coordinates (docs/designs/linear-integration.md §15, "the team
-- is the channel"). A Linear conversation is now a TEAM, keyed on `issue.team.id`, so the rows
-- keyed on the workspace's `organizationId` describe a channel that no longer exists.
--
-- Nothing has shipped on the old coordinates, so nothing is rewritten: the conversation rows are
-- re-seeded by the connect tail and the credential reconciler's team pass, and sessions that arrive
-- on the new coordinates are simply new threads. Matching is EXACT — a row survives only if its
-- channel is the bot's own workspace id, so a team row can never be caught by it.

DELETE FROM "integration_channel" ic
USING "integration" i, "bot" b
WHERE ic."integrationId" = i."id"
  AND i."botId" = b."id"
  AND b."platform" = 'linear'
  AND ic."channelId" = b."workspaceId";

DELETE FROM "session_meta" sm
USING "bot" b
WHERE sm."platform" = 'linear'
  AND b."platform" = 'linear'
  AND sm."channel" = b."workspaceId";
