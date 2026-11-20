-- A per-organization session policy a deployment-level service delivers by revision (org-session-policy.md).
CREATE TABLE "org_session_policy" (
    "orgId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "monthlySessionLimit" INTEGER,
    "historyRetentionDays" INTEGER,
    "enforce" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_session_policy_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "org_session_policy" ADD CONSTRAINT "org_session_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
