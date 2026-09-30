-- Periodic re-attestation of repository grants (docs/designs/agent-multi-repo-authorization.md, Re-attestation).
-- Additive: every existing grant is attested by its creator, has never been re-checked, and is honored.
BEGIN;

CREATE TYPE "RepoGrantStaleReason" AS ENUM ('access_lost', 'identity_unlinked', 'attester_removed');

ALTER TABLE "agent_repo_authorization"
  ADD COLUMN "attestedByUserId" TEXT,
  ADD COLUMN "attestationCheckedAt" TIMESTAMPTZ(6),
  ADD COLUMN "staleSince" TIMESTAMPTZ(6),
  ADD COLUMN "staleReason" "RepoGrantStaleReason";

UPDATE "agent_repo_authorization" SET "attestedByUserId" = "createdByUserId";

ALTER TABLE "agent_repo_authorization"
  ADD CONSTRAINT "agent_repo_authorization_attestedByUserId_fkey"
  FOREIGN KEY ("attestedByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "agent_repo_authorization_provider_attestationCheckedAt_idx"
  ON "agent_repo_authorization"("provider", "attestationCheckedAt");

COMMIT;
