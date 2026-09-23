-- The plugin's connection settings schema, reported with the other probe facts so the console can
-- render settings as fields (memory-evolution.md §3.3.2). Additive: null until the next probe.
BEGIN;

ALTER TABLE "external_memory_connection"
  ADD COLUMN "configSchema" JSONB;

COMMIT;
