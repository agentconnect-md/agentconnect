-- Open (email-agnostic), single-use activation links — waitlist-and-login.md §6a.
--
-- A second flavor of activation link alongside waitlist_entry's per-email join link:
-- not keyed by an email and requiring no waitlist entry, so it can admit someone who
-- never applied. The first account to redeem it consumes it; a repeat by that SAME
-- account is idempotent, anybody else is refused indistinguishably from
-- expired/revoked. The token is minted by the external admin app under its own HMAC
-- domain ('oa1') and only VERIFIED by the CP on redeem.
--
-- Write responsibilities mirror waitlist_entry (§7 contract 2): the admin app may
-- mint + revoke; the redemption columns and app_user.activatedAt stay CP-only.

CREATE TABLE "open_activation_link" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayTail" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedByUserId" TEXT,
    "redeemedEmail" TEXT,
    "redeemedAt" TIMESTAMPTZ(6),

    CONSTRAINT "open_activation_link_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "open_activation_link_tokenHash_key" ON "open_activation_link"("tokenHash");

-- Least-privilege grants for the EXTERNAL admin app (the minter). Same discipline and
-- the same role-existence guard as the waitlist_entry grants, so this is a safe no-op
-- on an OSS / single-app deploy where the role was never provisioned:
--   • SELECT on the whole row (list / reconcile / show redemption state);
--   • INSERT on the mint columns; UPDATE on revokedAt + note only;
--   • NO write on redeemedAt / redeemedByUserId / redeemedEmail, and no way to grant
--     itself one — a compromised admin app still cannot activate a user;
--   • NO write on tokenHash after insert, so a link's identity is immutable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waitlist_admin') THEN
    GRANT SELECT ON "open_activation_link" TO "waitlist_admin";
    GRANT INSERT (
      "id", "tokenHash", "displayTail", "note",
      "expiresAt", "revokedAt", "createdByUserId", "createdAt"
    ) ON "open_activation_link" TO "waitlist_admin";
    GRANT UPDATE ("note", "revokedAt") ON "open_activation_link" TO "waitlist_admin";
  END IF;
END
$$;
