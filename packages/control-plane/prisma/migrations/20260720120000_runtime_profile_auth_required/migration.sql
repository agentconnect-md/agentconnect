-- Per-runtime login warning: the daemon's probe was rejected with the ACP
-- auth-required error (-32000) — the runtime is installed but needs an
-- interactive login on the daemon host. Defaults false so existing rows (and
-- older daemons that never report the field) read as "no warning".

ALTER TABLE "runtime_profile" ADD COLUMN "authRequired" BOOLEAN NOT NULL DEFAULT false;
