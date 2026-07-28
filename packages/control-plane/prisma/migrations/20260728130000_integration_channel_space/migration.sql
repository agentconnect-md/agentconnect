-- The space (Discord guild / server) a reported conversation lives in.
--
-- One Discord bot is commonly invited to several servers, each of which has its own
-- "#general". The channel name alone therefore does not identify the row the operator
-- is configuring, so the daemon reports the enclosing server alongside it.
--
-- `spaceId` is the identity — Discord permits two distinct guilds to carry the SAME
-- name, so grouping the console's rows on the label would merge them and hide the very
-- ambiguity this resolves. `space` is the display label only.
--
-- Both nullable: platforms with a single implicit container per bot (Slack workspace,
-- Telegram, Feishu tenant), DM rows, and Discord rows whose guild has not been resolved
-- yet all leave them NULL.
ALTER TABLE "integration_channel" ADD COLUMN "spaceId" TEXT;
ALTER TABLE "integration_channel" ADD COLUMN "space" TEXT;
