-- Domains an organization claims for single sign-on (docs/designs/organization-sso.md §3).
ALTER TYPE "AuditKind" ADD VALUE IF NOT EXISTS 'org_sso_change';

CREATE TABLE "org_domain" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "challengeExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6),
    "lastCheckedAt" TIMESTAMPTZ(6),
    "lastCheckOk" BOOLEAN,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_domain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_domain_orgId_domain_key" ON "org_domain"("orgId", "domain");

CREATE INDEX "org_domain_domain_idx" ON "org_domain"("domain");

-- Only a verified row holds a domain; pending claims by other organizations may coexist.
CREATE UNIQUE INDEX "org_domain_verified_domain_key" ON "org_domain"("domain") WHERE "verifiedAt" IS NOT NULL;

ALTER TABLE "org_domain" ADD CONSTRAINT "org_domain_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
