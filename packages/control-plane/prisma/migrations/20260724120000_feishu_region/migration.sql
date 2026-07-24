-- Feishu / Lark region selector. A Feishu self-built app is registered in exactly one
-- open-platform region — mainland China ('feishu', open.feishu.cn) or international
-- ('lark', open.larksuite.com). The daemon SDK + CP credential verifier must talk to the
-- matching gateway, so the operator's choice is persisted per integration. NULL ⇒ 'feishu'
-- (the historical default; also the value for every non-feishu integration). Public config,
-- never secret material.
ALTER TABLE "integration" ADD COLUMN "feishuRegion" TEXT;
