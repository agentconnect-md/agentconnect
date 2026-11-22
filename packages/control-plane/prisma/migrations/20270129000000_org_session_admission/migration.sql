-- One row per session a daemon asked to admit, so a re-sent admit answers the same and never counts twice (org-session-policy.md).
CREATE TABLE "org_session_admission" (
    "sessionId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "monthStart" TIMESTAMPTZ(6) NOT NULL,
    "counted" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_session_admission_pkey" PRIMARY KEY ("sessionId")
);

CREATE INDEX "org_session_admission_orgId_idx" ON "org_session_admission"("orgId");

ALTER TABLE "org_session_admission" ADD CONSTRAINT "org_session_admission_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
