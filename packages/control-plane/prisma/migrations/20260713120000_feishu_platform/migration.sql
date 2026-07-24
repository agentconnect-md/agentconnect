-- Feishu / Lark integration: a Feishu self-built app authenticates the long-connection
-- WebSocket with an appId + appSecret PAIR. These reuse the existing two-slot bot_secret
-- (botToken = appSecret, appToken = appId — appToken is already nullable since Telegram),
-- so no column change is needed. Add the 'feishu' value to the Platform enum. Postgres
-- 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is
-- not used in the same transaction (this migration only adds it).
ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'feishu';
