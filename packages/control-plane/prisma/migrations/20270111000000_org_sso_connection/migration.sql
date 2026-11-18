-- An organization's SSO connection (docs/designs/organization-sso.md §3).
CREATE TABLE "org_sso_connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "logtoConnectorId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "testNonceHash" TEXT,
    "testExpiresAt" TIMESTAMPTZ(6),
    "testedAt" TIMESTAMPTZ(6),
    "activatedAt" TIMESTAMPTZ(6),
    "configChangedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_connection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_sso_connection_orgId_key" ON "org_sso_connection"("orgId");

CREATE UNIQUE INDEX "org_sso_connection_logtoConnectorId_key" ON "org_sso_connection"("logtoConnectorId");

CREATE UNIQUE INDEX "org_sso_connection_testNonceHash_key" ON "org_sso_connection"("testNonceHash");

ALTER TABLE "org_sso_connection" ADD CONSTRAINT "org_sso_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
