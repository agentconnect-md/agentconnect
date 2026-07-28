-- Make the DELETION ITSELF record the identity boundary.
--
-- The companion table is written by the CP's auth plane when it NOTICES that a
-- signed-in subject's row is gone. That leaves one ordering open: delete the row,
-- restart the CP before any request observes it, and the fresh process sees an
-- unknown subject and JIT-provisions a replacement account for a still-live
-- pre-deletion bearer.
--
-- Closing it needs evidence written at deletion time, but the CP does not perform
-- the deletion — the external admin app does (waitlist-and-login.md §7), and it must
-- not have to change for this invariant to hold. So the evidence is written where
-- both meet: the database. This trigger fires for ANY deleter, the CP included, and
-- needs no cooperation from the deleting application.
--
-- Scope notes:
--   • Only rows that HAVE an `oidcSubject` matter — an invited-but-never-signed-in
--     row has no identity to fence, and the CP legitimately deletes such rows when
--     merging an invite into a claimed account (upgradeSyntheticEmail).
--   • Expiry-limited (24h, mirroring TOMBSTONE_TTL_SECONDS in http/plugins/auth.ts):
--     a boundary around one deletion, NOT a ban on the identity.
--   • GREATEST() on conflict keeps the boundary monotonic — a re-created and
--     re-deleted identity never moves its cutoff backwards.
--   • TRUNCATE does not fire row triggers, so test teardown is unaffected.

CREATE OR REPLACE FUNCTION "record_deleted_identity"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."oidcSubject" IS NOT NULL THEN
    INSERT INTO "deleted_identity_cutoff" ("oidcSubject", "cutoffAt", "expiresAt")
    VALUES (OLD."oidcSubject", now(), now() + interval '24 hours')
    ON CONFLICT ("oidcSubject") DO UPDATE SET
      "cutoffAt"  = GREATEST("deleted_identity_cutoff"."cutoffAt", EXCLUDED."cutoffAt"),
      "expiresAt" = GREATEST("deleted_identity_cutoff"."expiresAt", EXCLUDED."expiresAt");
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "app_user_record_deleted_identity"
AFTER DELETE ON "app_user"
FOR EACH ROW EXECUTE FUNCTION "record_deleted_identity"();
