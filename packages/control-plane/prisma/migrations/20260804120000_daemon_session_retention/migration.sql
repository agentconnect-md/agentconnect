-- Console-set "Expire sessions" window for the daemon's LOCAL session store
-- ('never' | '7d' | '30d' | '90d'). The CP stores and delivers the value
-- (register/ok baseline + config/push hot update); the daemon's hourly retention
-- sweep is what actually deletes expired finished sessions. Backfilling existing
-- rows with '7d' matches the daemon-side config default, so behavior is unchanged
-- for every daemon that never had the option set.
ALTER TABLE "daemon" ADD COLUMN "sessionRetention" TEXT NOT NULL DEFAULT '7d';
