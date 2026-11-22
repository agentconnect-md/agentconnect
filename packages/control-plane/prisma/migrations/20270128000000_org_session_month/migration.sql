-- Sessions an organization started per UTC month, counted when the CP first records each one; no backfill (org-session-policy.md).
CREATE TABLE "org_session_month" (
    "orgId" TEXT NOT NULL,
    "monthStart" TIMESTAMPTZ(6) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "org_session_month_pkey" PRIMARY KEY ("orgId","monthStart")
);

ALTER TABLE "org_session_month" ADD CONSTRAINT "org_session_month_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
