-- #2812: exempt an agent's current append sessions from idle retention.
ALTER TABLE "agent" ADD COLUMN "keepAppendSessions" BOOLEAN NOT NULL DEFAULT false;
