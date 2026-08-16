-- The per-org execution envelope is gone: #964 deleted the operator, the
-- `AgentConnectOrg` CR, the control plane's spec projector, and the
-- `org_cluster_execution` repository/routes, leaving these tables with no reader
-- and no writer. The shared pool replaced the model outright
-- (docs/designs/k8s-daemon-pool.md), so nothing here migrates anywhere: no
-- production or staging envelope ever existed, and the disposable test
-- organizations that had one were torn down with their CRs.
--
-- FORWARD-ONLY: a binary from before #964 selects these tables. Every control
-- plane that could has long drained; recovery is a forward deploy, not a rollback.

-- Each row names an `AgentConnectOrg` to delete for an organization that is
-- already gone. No operator remains to honour one, and the CRD itself was deleted
-- from the only cluster that ever had it, so a surviving row addresses nothing.
DROP TABLE IF EXISTS "pending_envelope_teardown";

-- Dropping the table takes its `org` foreign key and `resourceName` unique index.
DROP TABLE IF EXISTS "org_cluster_execution";

-- Only `org_cluster_execution.egressPolicy` ever used it.
DROP TYPE IF EXISTS "ClusterEgressPolicy";
