-- A run that was due and deliberately not run (agent paused, daemon draining) closes as `skipped`, not as a failure.
ALTER TYPE "CronRunStatus" ADD VALUE IF NOT EXISTS 'skipped';
