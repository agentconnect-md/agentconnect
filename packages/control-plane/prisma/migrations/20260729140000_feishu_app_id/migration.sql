-- Persist the Feishu/Lark app id as public bot metadata so the console can link
-- directly to the app's developer settings without reading bot_secret.
ALTER TABLE "bot" ADD COLUMN "feishuAppId" TEXT;

-- Development and legacy installations using the plaintext SecretCipher can be
-- backfilled in SQL. Encrypted values deliberately do not match; those rows keep
-- the regional developer-console fallback until their credentials are recreated.
UPDATE "bot" AS b
SET "feishuAppId" = s."appToken"
FROM "bot_secret" AS s
WHERE b."id" = s."botId"
  AND b."platform" = 'feishu'
  AND s."appToken" ~ '^cli_[A-Za-z0-9]+$';
