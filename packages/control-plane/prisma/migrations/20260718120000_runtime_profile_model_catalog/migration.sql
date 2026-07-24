-- Runtime model catalog (docs/designs/runtime-model-catalog.md §5).
-- `modelCatalog` stores the wire RuntimeModelCatalog object verbatim (one shape
-- shared by the wire, this column, and the DTO); `modelsSource` records the
-- provenance of models[] ('cached' | 'probed') so capability gates can treat a
-- hydrated last-good list as permissive. `runtimesSnapshotSeq` is the last
-- applied `facts/daemon-runtimes.seq` (per-connection monotonic, reset to NULL
-- on register) — older snapshots are dropped instead of committing out of order.

ALTER TABLE "runtime_profile"
  ADD COLUMN "modelCatalog" JSONB,
  ADD COLUMN "modelsSource" TEXT;

ALTER TABLE "daemon" ADD COLUMN "runtimesSnapshotSeq" INTEGER;
