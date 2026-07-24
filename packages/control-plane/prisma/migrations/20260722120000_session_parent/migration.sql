-- Persist daemon-reported session lineage so the console can navigate from a
-- session to its parent and children. The parent id intentionally has no foreign
-- key: ACP ids are opaque strings, and a cross-daemon parent snapshot may arrive
-- after its child (or be unavailable to this control plane).

ALTER TABLE "session_meta" ADD COLUMN "parentSessionId" TEXT;

CREATE INDEX "session_meta_parentSessionId_idx" ON "session_meta"("parentSessionId");
