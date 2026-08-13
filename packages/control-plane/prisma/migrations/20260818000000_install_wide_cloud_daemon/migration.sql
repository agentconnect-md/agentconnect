-- Each cloud-daemon Pod gets an org-less member row while org-scoped daemons are unchanged.
ALTER TABLE "daemon" ALTER COLUMN "orgId" DROP NOT NULL;

ALTER TABLE "daemon" ADD COLUMN "clusterPodUid" TEXT;

DROP INDEX "daemon_clusterIdentity_key";

-- Envelope identities remain one-to-one; PostgreSQL NULL semantics require this partial index.
CREATE UNIQUE INDEX "daemon_cluster_identity_envelope_key"
  ON "daemon"("clusterIdentity")
  WHERE "clusterIdentity" IS NOT NULL AND "clusterPodUid" IS NULL;

-- Cloud replicas share a ServiceAccount, but a reviewed Pod UID identifies one member.
CREATE UNIQUE INDEX "daemon_cluster_identity_pod_key"
  ON "daemon"("clusterIdentity", "clusterPodUid");

ALTER TABLE "daemon"
  ADD CONSTRAINT "daemon_cluster_pod_uid_install_scope_check"
  CHECK ("clusterPodUid" IS NULL OR "orgId" IS NULL);
