-- Merge the waitlist join link and the standalone activation link into ONE list —
-- waitlist-and-login.md §6.
--
-- Before: an activation link could only exist as a set of columns ON a waitlist_entry
-- row, so it was always keyed by an approved applicant's email and there was no way to
-- issue one to somebody who never applied.
--
-- After: waitlist_entry keeps only the APPLICATION (did they ask in, did an admin
-- approve) and every link lives in activation_link, where `email` is NULLABLE:
--   • non-null at mint  → bound to that applicant, only their verified email redeems it;
--   • null at mint      → unbound; ANY verified email may claim it and the FIRST
--                         redeemer's email is written in (with boundAt), which is what
--                         makes it single-use — afterwards it behaves exactly like a
--                         born-bound link.
-- One rule, one code path: a link is redeemable only by the email it is bound to.
--
-- Write split (§7 contract 2), same discipline as before: the admin app mints and
-- revokes, the CP writes only the binding + redemption columns. See the grants below.

CREATE TABLE "activation_link" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "boundAt" TIMESTAMPTZ(6),
    "tokenHash" TEXT NOT NULL,
    "displayTail" TEXT NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedByUserId" TEXT,
    "redeemedAt" TIMESTAMPTZ(6),

    CONSTRAINT "activation_link_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "activation_link_tokenHash_key" ON "activation_link"("tokenHash");

-- `email` is NOT unique: reissuing inserts a new row instead of mutating the old one,
-- so the list stays append-only. The index serves the admin app's per-applicant lookup.
CREATE INDEX "activation_link_email_idx" ON "activation_link"("email");

-- Carry every already-minted join link over so links in the wild keep working. They
-- are bound by construction, so boundAt is backdated to the approval (or row creation)
-- moment. joinExpiresAt was nullable but expiresAt is not — a legacy open-ended link
-- gets an explicit far-future expiry rather than being silently dropped.
INSERT INTO "activation_link" (
    "id", "email", "boundAt", "tokenHash", "displayTail", "note",
    "expiresAt", "revokedAt", "createdByUserId", "createdAt",
    "redeemedByUserId", "redeemedAt"
)
SELECT
    "id",
    "email",
    COALESCE("approvedAt", "createdAt"),
    "tokenHash",
    COALESCE("displayTail", '…legacy'),
    NULL,
    COALESCE("joinExpiresAt", TIMESTAMPTZ '2099-01-01 00:00:00+00'),
    "revokedAt",
    "approvedByUserId",
    "createdAt",
    "redeemedByUserId",
    "redeemedAt"
FROM "waitlist_entry"
WHERE "tokenHash" IS NOT NULL;

-- The entry is now the application record only.
DROP INDEX IF EXISTS "waitlist_entry_tokenHash_key";
ALTER TABLE "waitlist_entry"
    DROP COLUMN "tokenHash",
    DROP COLUMN "displayTail",
    DROP COLUMN "joinExpiresAt",
    DROP COLUMN "revokedAt",
    DROP COLUMN "redeemedByUserId",
    DROP COLUMN "redeemedAt";

-- Least-privilege grants for the EXTERNAL admin app. Same role-existence guard as the
-- original waitlist grants, so this is a safe no-op on an OSS / single-app deploy where
-- the role was never provisioned.
--
--   • SELECT on both rows (list / approve / reconcile / show redemption state);
--   • on activation_link: INSERT on the mint columns — INCLUDING "email", so it can
--     mint either flavor (an email ⇒ bound, NULL ⇒ unbound) — and UPDATE on note +
--     revokedAt only;
--   • NO write on "email"/"boundAt" via UPDATE: the admin app cannot rebind a link,
--     nor pre-bind one after minting, so the binding recorded on first use is
--     tamper-evident;
--   • NO write on redeemedAt / redeemedByUserId, and none on app_user."activatedAt" —
--     a compromised admin app still cannot activate anybody;
--   • NO write on tokenHash after insert, so a link's identity is immutable.
-- The waitlist_entry grants are re-issued because the approval columns it may write
-- changed shape (the mint/redeem columns are gone); UPDATE on a dropped column is
-- discarded by Postgres, so the old grant would silently narrow.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waitlist_admin') THEN
    GRANT SELECT ON "waitlist_entry" TO "waitlist_admin";
    GRANT INSERT (
      "id", "email", "status", "note", "source",
      "approvedByUserId", "approvedAt", "createdAt", "updatedAt"
    ) ON "waitlist_entry" TO "waitlist_admin";
    -- email stays non-updatable: it is the applicant's identity key.
    GRANT UPDATE (
      "status", "note", "source",
      "approvedByUserId", "approvedAt", "updatedAt"
    ) ON "waitlist_entry" TO "waitlist_admin";

    GRANT SELECT ON "activation_link" TO "waitlist_admin";
    GRANT INSERT (
      "id", "email", "boundAt", "tokenHash", "displayTail", "note",
      "expiresAt", "revokedAt", "createdByUserId", "createdAt"
    ) ON "activation_link" TO "waitlist_admin";
    GRANT UPDATE ("note", "revokedAt") ON "activation_link" TO "waitlist_admin";
  END IF;
END
$$;
