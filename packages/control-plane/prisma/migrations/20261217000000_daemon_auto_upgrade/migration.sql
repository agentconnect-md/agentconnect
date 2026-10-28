-- Daemon auto-upgrade (daemon-auto-upgrade.md §3, §6); nothing here uses 'deferred', so adding it in this transaction is safe.
ALTER TYPE "DaemonLifecycleOpStatus" ADD VALUE IF NOT EXISTS 'deferred';

CREATE TYPE "DaemonLifecycleOpTrigger" AS ENUM ('manual', 'auto');

ALTER TABLE "daemon_lifecycle_op" ADD COLUMN "trigger" "DaemonLifecycleOpTrigger" NOT NULL DEFAULT 'manual';

ALTER TABLE "daemon" ADD COLUMN "autoUpgrade" BOOLEAN NOT NULL DEFAULT false;
