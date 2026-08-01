-- Unresolved history is expected, not a fault. Enabling a provider policy hides
-- every candidate whose source scope the migration could not reconstruct, and
-- that scope can never be recovered (only NEW activity on the same session
-- rebinds it). Deriving `degraded` from that count therefore pinned every
-- organization with pre-existing history to a permanent fault state.
--
-- `legacyUnresolved` is the low-water mark of the unresolved count since
-- enablement: `degraded` now means the live count EXCEEDS it, i.e. a candidate
-- went unresolved after the policy was turned on — the actually actionable case.

ALTER TABLE "session_external_access_policy"
  ADD COLUMN "legacyUnresolved" INTEGER NOT NULL DEFAULT 0;

-- Adopt the current backlog as the mark for policies already enabled, and clear
-- the fault state they were pinned to. A live provider failure re-degrades on
-- the next classification; a stale 'degraded' here would never clear on its own.
--
-- The count MUST use the same predicate as `countExternalUnresolved` and the
-- classify path, `visibility = 'external'` included: a pending candidate that is
-- not external (an A2A child held private behind an unresolved parent, a row
-- tagged before its policy was ever enabled) is not hidden BY this policy, and
-- counting it here would set the mark above anything the live count can reach —
-- masking the first genuine degradation until the mark ratchets back down.
UPDATE "session_external_access_policy" AS p
SET "legacyUnresolved" = COALESCE(backlog."count", 0),
    "state" = CASE WHEN p."state" = 'degraded' THEN 'enabled'::"ExternalAccessPolicyState" ELSE p."state" END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT p2."orgId" AS "orgId",
         p2."provider" AS "provider",
         (
           SELECT COUNT(*)::int
           FROM "session_meta" s
           WHERE s."orgId" = p2."orgId"
             AND s."externalProvider" = p2."provider"
             AND s."visibility" = 'external'::"SessionVisibility"
             AND s."externalResolution" IN ('pending', 'invalid')
         ) AS "count"
  FROM "session_external_access_policy" p2
  WHERE p2."state" <> 'disabled'
) AS backlog
WHERE p."orgId" = backlog."orgId"
  AND p."provider" = backlog."provider";
