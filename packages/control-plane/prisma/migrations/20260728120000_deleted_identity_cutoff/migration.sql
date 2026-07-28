-- Deleted-account identity boundary, durable across CP restarts.
--
-- When the human-auth plane resolves a signed-in OIDC subject to a user row that no
-- longer exists (an admin deleted the account), it records the moment here. Every
-- token issued at or before that moment is then refused, so a still-valid
-- pre-deletion bearer cannot re-run JIT signup and recreate the account — the
-- in-process cutoff alone is forgotten on restart, which is exactly when a live old
-- session would slip through.
--
-- Expiry-limited on purpose: `expiresAt` is set well beyond any access-token
-- lifetime but is not permanent, so this is NOT a subject ban list. Whether a deleted
-- person may sign up again is the deleting application's policy, not this table's.
-- Rows are pruned opportunistically when a new cutoff is written.

CREATE TABLE "deleted_identity_cutoff" (
    "oidcSubject" TEXT NOT NULL,
    "cutoffAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_identity_cutoff_pkey" PRIMARY KEY ("oidcSubject")
);

CREATE INDEX "deleted_identity_cutoff_expiresAt_idx" ON "deleted_identity_cutoff"("expiresAt");
