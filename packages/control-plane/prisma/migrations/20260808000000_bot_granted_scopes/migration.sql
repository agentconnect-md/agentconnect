-- Bot scopes Slack reported as granted for the bot's CURRENT credential (the
-- `x-oauth-scopes` header observed when an install/refresh verified the token).
-- Empty means "never observed" — Slack omits the header at times — and NEVER
-- "granted nothing": a real bot grant always carries at least one scope. Read
-- to pick a credential that provably holds a scope (the session-access
-- workspace checker needs `users:read`); never an authorization fence itself.
ALTER TABLE "bot"
  ADD COLUMN "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
