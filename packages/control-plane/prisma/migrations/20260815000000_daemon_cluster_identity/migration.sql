-- An in-cluster daemon authenticates with its projected ServiceAccount token
-- instead of an API key, so the daemon record is bound to the Kubernetes identity
-- TokenReview reports rather than to a minted key. The unique index is the store's
-- half of that guarantee: one daemon record per identity, so an envelope can never
-- end up with two records competing for its placements.

-- AlterTable
ALTER TABLE "daemon" ADD COLUMN "clusterIdentity" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "daemon_clusterIdentity_key" ON "daemon"("clusterIdentity");
