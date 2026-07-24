-- Closed-beta waitlist admission.
-- Adds the formal-user marker on app_user and the shared waitlist_entry table.
-- The join-link columns mirror org_invite_link (peppered hash + tail + expiry/
-- revoke); the token is minted by the external admin app and only verified by the
-- CP on redeem. Write responsibilities are split by a least-privilege DB role in
-- the companion grants migration (§7 contract 2).

-- "formal / activated" user marker: set ONLY by the CP redeem path.
ALTER TABLE "app_user" ADD COLUMN "activatedAt" TIMESTAMPTZ(6);

CREATE TYPE "WaitlistStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "waitlist_entry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "source" TEXT,
    "tokenHash" TEXT,
    "displayTail" TEXT,
    "joinExpiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMPTZ(6),
    "redeemedByUserId" TEXT,
    "redeemedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "waitlist_entry_email_key" ON "waitlist_entry"("email");

CREATE UNIQUE INDEX "waitlist_entry_tokenHash_key" ON "waitlist_entry"("tokenHash");
