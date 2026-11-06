-- Org default for a new daemon's auto-upgrade switch (daemon-auto-upgrade.md §3.1).
ALTER TABLE "org" ADD COLUMN "defaultDaemonAutoUpgrade" BOOLEAN NOT NULL DEFAULT false;
