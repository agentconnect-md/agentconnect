-- Two tiers of credential evidence on a bot (preset-agents.md §5.3).
--
-- A definitive answer (a lifecycle event, or a probe the platform answers with a
-- dead-credential code) still revokes; these columns record how it was learned
-- and the platform's own code, so the console can say why. An ambiguous probe
-- answer (Slack's `invalid_auth` also answers a caller outside the app's IP
-- allowlist) never revokes: it only marks the bot, first-seen time and code.
--
-- All nullable and unset on existing rows: a revocation recorded before this
-- migration reads as having no recorded evidence. A fresh credential clears
-- every column together with `revokedAt` (`BotRepo.bumpCredential`).
BEGIN;

ALTER TABLE "bot"
  ADD COLUMN "revokedReason" TEXT,
  ADD COLUMN "revokedEvidence" TEXT,
  ADD COLUMN "revokedCode" TEXT,
  ADD COLUMN "credentialRejectedAt" TIMESTAMPTZ(6),
  ADD COLUMN "credentialRejectedCode" TEXT;

COMMIT;
