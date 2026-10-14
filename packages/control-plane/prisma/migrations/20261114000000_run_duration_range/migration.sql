-- Preserve integer millisecond durations across the full JavaScript safe-integer range.
ALTER TABLE "cron_run" ALTER COLUMN "durationMs" TYPE DOUBLE PRECISION;
ALTER TABLE "hook_run" ALTER COLUMN "durationMs" TYPE DOUBLE PRECISION;
