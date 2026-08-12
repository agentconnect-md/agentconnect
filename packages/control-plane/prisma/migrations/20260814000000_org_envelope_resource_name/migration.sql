-- The envelope namespace is no longer control-plane input: the operator derives
-- it from the install prefix and the CR name and publishes it on status.namespace.
-- What the control plane still owns is the CR NAME, which is what these columns
-- have really held — rename them to say so.
--
-- v1alpha1 has no production consumers and cluster execution is off by default.
-- A row written before this migration still carries the old, prefix-INCLUDING
-- value, and the name is only ever written on insert. Its CR also carries the
-- spec.targetNamespace the old writer set, which this one no longer sends — and
-- since server-side apply would drop a field this manager owns, the CRD's
-- immutability rule REJECTS that apply rather than letting the org silently move
-- to a doubly-prefixed namespace. So such a row is retired, not migrated: disable
-- cluster execution (which tears the envelope down under the stored name), delete
-- the row, and enable again.

-- AlterTable
ALTER TABLE "org_cluster_execution" RENAME COLUMN "targetNamespace" TO "resourceName";

-- AlterIndex
ALTER INDEX "org_cluster_execution_targetNamespace_key" RENAME TO "org_cluster_execution_resourceName_key";

-- AlterTable
ALTER TABLE "pending_envelope_teardown" RENAME COLUMN "targetNamespace" TO "resourceName";
