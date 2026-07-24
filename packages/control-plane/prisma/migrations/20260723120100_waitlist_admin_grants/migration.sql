-- Least-privilege DB role for the EXTERNAL waitlist admin app (waitlist-and-login.md
-- §7 contract 2). The admin app shares this Postgres but never runs migrations; the CP
-- (the only migrating component) grants it exactly the reads + approval/mint writes it
-- needs. A subset Prisma client is NOT a security boundary — the boundary is here, at
-- column-level GRANTs:
--   • SELECT on the whole row (it must read entries to approve / reconcile);
--   • INSERT/UPDATE on the approval + mint columns only;
--   • NO write on the redemption columns (redeemedAt / redeemedByUserId) or on
--     app_user.activatedAt — those are the CP's alone, so a compromised admin app
--     still cannot activate a user;
--   • no privileges on any other table.
-- updatedAt is included because Prisma's @updatedAt is client-maintained (an approve
-- would otherwise fail with a permission error). email is grantable on INSERT so the
-- admin can seed admin-sourced entries, but NOT on UPDATE (the email is the identity key).
--
-- Guarded by a role-existence check: the role is provisioned out-of-band,
-- so on an OSS / single-app deploy where it does not exist this migration is a safe
-- no-op and `migrate deploy` never fails.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waitlist_admin') THEN
    GRANT SELECT ON "waitlist_entry" TO "waitlist_admin";
    GRANT INSERT (
      "id", "email", "status", "note", "source",
      "tokenHash", "displayTail", "joinExpiresAt", "revokedAt",
      "approvedByUserId", "approvedAt", "createdAt", "updatedAt"
    ) ON "waitlist_entry" TO "waitlist_admin";
    GRANT UPDATE (
      "status", "note", "source",
      "tokenHash", "displayTail", "joinExpiresAt", "revokedAt",
      "approvedByUserId", "approvedAt", "updatedAt"
    ) ON "waitlist_entry" TO "waitlist_admin";
  END IF;
END
$$;
