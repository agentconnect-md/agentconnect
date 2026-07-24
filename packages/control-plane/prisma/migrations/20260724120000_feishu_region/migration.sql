-- Feishu / Lark region selector. A Feishu self-built app is registered in exactly one
-- open-platform region — mainland China ('feishu', open.feishu.cn) or international
-- ('lark', open.larksuite.com). The daemon SDK + CP credential verifier must talk to the
-- matching gateway, so the operator's choice is persisted. NULL ⇒ 'feishu' (the historical
-- default; also the value for every non-feishu bot/integration). Public config, never secret.
--
-- The DURABLE home is the bot row: uninstall keeps the bot (+ its credentials) and frees it
-- for reuse, so the region must survive there to reinstall a freed Lark bot correctly. The
-- integration row mirrors it at install time (like `integration.name` mirrors `bot.name`),
-- so the wire-spec builder reads it without a bot join.
ALTER TABLE "bot" ADD COLUMN "feishuRegion" TEXT;
ALTER TABLE "integration" ADD COLUMN "feishuRegion" TEXT;
