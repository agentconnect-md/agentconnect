-- Metering starts at the upgrade for managed desktops that predate it, not at their creation (computer-use.md §15.5).
UPDATE "computer" SET "poolMeteredAt" = now() WHERE "kind" = 'managed' AND "poolMeteredAt" IS NULL;
