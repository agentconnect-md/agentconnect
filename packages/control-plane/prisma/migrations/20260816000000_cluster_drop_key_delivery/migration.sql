-- The control plane no longer delivers a key to an in-cluster daemon: it
-- authenticates with the ServiceAccount token the kubelet projects into its pod
-- (docs/designs/agentconnect-org-operator.md, "Daemon identity"). Everything the
-- publish path needed goes with it — the Secret name, the revision handle, the
-- staged/committed key slots, the cluster rotation sequence, the owed rollout
-- flag, and the held-revocation queue.
--
-- FORWARD-ONLY: an older binary selects columns this drops, so every
-- `org_cluster_execution` read fails for it until it drains. Recovery is a
-- forward fix, not an old-binary restart.

-- Settle what the queue still owed BEFORE dropping it. Daemon keys never expire,
-- so a key named here and left alone would stay live with nothing able to revoke
-- it: the committed and staged credentials plus every queued intent are the whole
-- set the retired path minted. The pods that could still be holding one are
-- recreated by the operator without a Secret volume in the same release.
UPDATE "api_key"
SET "revokedAt" = CURRENT_TIMESTAMP, "revokedReason" = 'cluster daemon key delivery retired'
WHERE "revokedAt" IS NULL
  AND "id" IN (
    SELECT "credentialApiKeyId" FROM "org_cluster_execution" WHERE "credentialApiKeyId" IS NOT NULL
    UNION
    SELECT "credentialStagedApiKeyId" FROM "org_cluster_execution" WHERE "credentialStagedApiKeyId" IS NOT NULL
    UNION
    SELECT "apiKeyId" FROM "pending_daemon_key_revocation"
  );

-- The daemon record the key was minted for is NOT dropped: an envelope
-- provisioned under that path has no `daemon.clusterIdentity` until its pod
-- reconnects, and this is what the first token connect adopts so its placements
-- and session history survive.
ALTER TABLE "org_cluster_execution" RENAME COLUMN "credentialDaemonId" TO "legacyKeyDaemonId";

-- The claim outlives the credential: enable, disable and the teardown drain
-- still race each other on one row.
ALTER TABLE "org_cluster_execution" RENAME COLUMN "credentialRotationAt" TO "envelopeTransitionAt";
ALTER TABLE "org_cluster_execution" RENAME COLUMN "credentialRotationToken" TO "envelopeTransitionToken";

ALTER TABLE "org_cluster_execution"
  DROP COLUMN "credentialSecretName",
  DROP COLUMN "credentialRevision",
  DROP COLUMN "credentialApiKeyId",
  DROP COLUMN "credentialStagedApiKeyId",
  DROP COLUMN "credentialRotationSeq",
  DROP COLUMN "credentialRolloutPending";

DROP TABLE "pending_daemon_key_revocation";
