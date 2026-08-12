-- `RegisterReq.cluster` — a daemon's own report that it runs as an operator-managed
-- pod, so its version is its container image rather than an npm install it can
-- replace. `clusterIdentity` already says WHO an in-cluster daemon is; this says what
-- its lifecycle is, which is the question the console's restart/upgrade controls ask.
-- Defaults false so every existing row reads as the machine it is until it re-registers.

-- AlterTable
ALTER TABLE "daemon" ADD COLUMN "cluster" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: an envelope daemon already bound to a Kubernetes identity is a cluster
-- daemon by construction, and its next register would set this anyway — do it now so a
-- console opened before that reconnect does not offer it an npm upgrade.
UPDATE "daemon" SET "cluster" = true WHERE "clusterIdentity" IS NOT NULL;
