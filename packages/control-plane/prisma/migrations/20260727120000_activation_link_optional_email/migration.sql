-- Activation-link redesign (waitlist-and-login.md §6) — make `waitlist_entry` carry
-- BOTH kinds of activation link in one table, keyed by whether `email` is set:
--   • email SET  → strong binding: only that verified email may redeem (unchanged);
--   • email NULL → one-time BEARER link: any verified identity may redeem it once,
--     and the redeemer's verified email is recorded in `redeemedEmail`.
--
-- Changes:
--   1. `email` becomes NULLABLE. The existing UNIQUE index is kept as-is — Postgres
--      treats NULLs as DISTINCT, so unlimited bearer rows (email NULL) coexist while
--      real emails still cannot collide (self-signup upserts keep working).
--   2. `name` — display name for the applicant/invitee, writable by the admin app.
--   3. `redeemedEmail` — the redeemer's verified email; CP-only (audit for bearer links).

ALTER TABLE "waitlist_entry" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "waitlist_entry" ADD COLUMN "name" TEXT;
ALTER TABLE "waitlist_entry" ADD COLUMN "redeemedEmail" TEXT;

-- Extend the least-privilege admin-app role (see 20260723120100_waitlist_admin_grants):
--   • `name` is grantable on INSERT and UPDATE (admin display metadata);
--   • `email` stays INSERT-only (identity key, never updated by the admin app);
--   • `redeemedEmail` is NOT granted — like the other redeemed* columns it is the
--     CP's alone, so a compromised admin app still cannot forge a redemption.
-- Guarded by a role-existence check so OSS / single-app deploys are a safe no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waitlist_admin') THEN
    GRANT INSERT ("name") ON "waitlist_entry" TO "waitlist_admin";
    GRANT UPDATE ("name") ON "waitlist_entry" TO "waitlist_admin";
  END IF;
END
$$;
