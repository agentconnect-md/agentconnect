-- The maintenance purpose an admission was exempted from the count for; null for every other admission (org-session-policy.md).
ALTER TABLE "org_session_admission" ADD COLUMN "maintenance" TEXT;

-- One agent's exempt admissions since the current UTC day start, read under the per-agent daily cap.
CREATE INDEX "org_session_admission_maintenance_agentId_createdAt_idx" ON "org_session_admission"("agentId", "createdAt") WHERE "maintenance" IS NOT NULL;
