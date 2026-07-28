-- The space (Discord guild / server) a reported conversation lives in.
--
-- One Discord bot is commonly invited to several servers, each of which has its own
-- "#general". The channel name alone therefore does not identify the row the operator
-- is configuring, so the daemon reports the enclosing server's name alongside it.
-- Nullable: platforms with a single implicit container per bot (Slack workspace,
-- Telegram, Feishu tenant), DM rows, and Discord rows whose guild name has not been
-- resolved yet all leave it NULL.
ALTER TABLE "integration_channel" ADD COLUMN "space" TEXT;
