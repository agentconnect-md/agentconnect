-- Unresolved history is expected, not a fault. Enabling a provider policy hides
-- every candidate whose source scope the migration could not reconstruct, and
-- that scope only comes back if new trusted activity rebinds the same session.
-- Deriving `degraded` from the unresolved COUNT therefore pinned every
-- organization with pre-existing history to a permanent fault state.
--
-- The distinction has to live per row, not as an aggregate: with a count, a
-- legacy row settling would offset a genuinely new unresolved candidate and
-- silently clear the fault while it is still live. `legacyUnresolved`
-- marks the rows that were already unresolved at enablement; `degraded` now
-- means an unresolved row exists WITHOUT that mark.

ALTER TABLE "session_meta"
  ADD COLUMN "legacyUnresolved" BOOLEAN NOT NULL DEFAULT false;

-- Adopt the current backlog of every enabled policy as legacy. Same predicate as
-- `countExternalUnresolved` and the classify path, `visibility = 'external'`
-- included: a pending candidate that is not external (an A2A child held private
-- behind an unresolved parent, a row tagged before its policy was ever enabled)
-- is not hidden BY this policy and must not be absolved by it either.
UPDATE "session_meta" s
SET "legacyUnresolved" = true
FROM "session_external_access_policy" p
WHERE p."orgId" = s."orgId"
  AND p."provider" = s."externalProvider"
  AND p."state" <> 'disabled'::"ExternalAccessPolicyState"
  AND s."visibility" = 'external'::"SessionVisibility"
  AND s."externalResolution" IN ('pending'::"ExternalResolution", 'invalid'::"ExternalResolution");

-- Every row that made a policy degraded is now marked legacy, so the fault state
-- no longer holds. A live provider failure re-degrades on the next
-- classification; a stale 'degraded' here would never clear on its own.
UPDATE "session_external_access_policy"
SET "state" = 'enabled'::"ExternalAccessPolicyState",
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "state" = 'degraded'::"ExternalAccessPolicyState";
