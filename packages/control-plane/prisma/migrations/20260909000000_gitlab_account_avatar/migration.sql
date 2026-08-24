-- The agent icon last uploaded as the account's GitLab avatar (§7.2). Null on
-- every existing row: the next convergence uploads once and records it.
ALTER TABLE "gitlab_agent_account" ADD COLUMN "avatarFingerprint" TEXT;

-- The record-first service-account create window (§7.2). Persisted BEFORE the
-- provider write, so a crash between GitLab creating the account and the row
-- committing its numeric id can still recover that account instead of refusing
-- the username as foreign.
ALTER TABLE "gitlab_agent_account" ADD COLUMN "createAttemptId" TEXT;
ALTER TABLE "gitlab_agent_account" ADD COLUMN "createAttemptAt" TIMESTAMPTZ(6);
ALTER TABLE "gitlab_agent_account" ADD COLUMN "createAttemptKnownIds" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[];
