-- The Slack App Configuration refresh token is now OPTIONAL. When a caller stores
-- only the access (config) token, the row keeps no refresh token; the access token
-- works until it expires (~12h), after which the caller re-enters it. A stored
-- refresh token still auto-rotates the pair so it never needs re-entry.
ALTER TABLE "public"."slack_user_config" ALTER COLUMN "refreshToken" DROP NOT NULL;
