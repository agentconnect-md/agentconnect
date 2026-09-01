-- The two provider-owned Linear tables (docs/designs/linear-integration.md §7.2).
--
-- `linear_token` holds one connected workspace's OAuth grant, keyed by the CONNECTION identity
-- (orgId, clientId, organizationId) rather than by the Bot row id: the grant belongs to the
-- workspace's authorization of the deployment's one OAuth app, so it is written before the Bot row
-- exists and survives member churn. Both token values pass through SecretCipher at the repository
-- seam. `linear_install_state` is the connect funnel's one-shot OAuth state nonce and carries no
-- secret material; like the Slack funnel tables it takes no FKs and is TTL-reaped.

CREATE TABLE "linear_token" (
    "orgId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "linear_token_pkey" PRIMARY KEY ("orgId", "clientId", "organizationId")
);

ALTER TABLE "linear_token" ADD CONSTRAINT "linear_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "linear_install_state" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "defaultAgentId" UUID,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linear_install_state_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "linear_install_state_orgId_idx" ON "linear_install_state"("orgId");
