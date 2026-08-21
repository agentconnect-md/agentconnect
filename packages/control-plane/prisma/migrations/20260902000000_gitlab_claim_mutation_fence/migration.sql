-- §10.2 review follow-up: the claim guard must not read "all external ids are
-- null" as "no provider mutation ever began" — a crash between an external
-- create and its local id write would then let a binding/org deletion release
-- the claim over live provider state. The saga now durably flips the claim out
-- of `provisioning` BEFORE its first provider write; the guard keys on that.
CREATE OR REPLACE FUNCTION gitlab_binding_claim_guard() RETURNS trigger AS $$
DECLARE
    claim_state text;
    token_ids bigint[];
    mutated boolean;
BEGIN
    SELECT "state" INTO claim_state
      FROM "code_host_repository_claim"
     WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    IF claim_state IS NULL THEN
        RETURN OLD;
    END IF;
    SELECT array_agg("externalTokenId") INTO token_ids
      FROM "gitlab_project_credential" WHERE "bindingId" = OLD."id";
    mutated := claim_state <> 'provisioning'
        OR OLD."serviceAccountUserId" IS NOT NULL
        OR OLD."webhookId" IS NOT NULL
        OR token_ids IS NOT NULL;
    IF mutated THEN
        UPDATE "code_host_repository_claim"
           SET "bindingRef" = NULL,
               "state" = 'cleanup_pending',
               "tombstone" = jsonb_build_object(
                   'projectId', OLD."projectId"::text,
                   'projectPath', OLD."projectPath",
                   'serviceAccountUserId', OLD."serviceAccountUserId"::text,
                   'webhookId', OLD."webhookId"::text,
                   'externalTokenIds', to_jsonb(COALESCE(token_ids, ARRAY[]::bigint[]))
               )
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    ELSE
        DELETE FROM "code_host_repository_claim"
         WHERE "provider" = 'gitlab' AND "externalId" = OLD."projectId" AND "bindingRef" = OLD."id";
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- §10.2 mutual exclusion between provisioning and cleanup: a provisioning run
-- RESERVES the claim before any provider write; cleanup may not begin while the
-- reservation is held, and a held fence cannot be re-acquired by cleanup racing
-- the check-to-write window.
ALTER TABLE "code_host_repository_claim" ADD COLUMN "opOwner" TEXT;
ALTER TABLE "code_host_repository_claim" ADD COLUMN "opLeaseUntil" TIMESTAMPTZ(6);
