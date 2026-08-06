-- One row per deleted organization: its transit key is still to be destroyed.
-- Written in the same transaction that deletes the org, drained by the
-- operator-run shred CLI. No foreign key by design — the row must outlive the
-- organization it names (docs/designs/per-org-secret-encryption.md §6).
CREATE TABLE "pending_key_shred" (
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_key_shred_pkey" PRIMARY KEY ("orgId")
);
