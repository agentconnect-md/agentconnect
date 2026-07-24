-- One fixed-role, seven-day, unlimited-use invite link per organization. The
-- plaintext token is never persisted; tokenHash is a domain-separated HMAC.
ALTER TYPE "AuditKind" ADD VALUE 'org_invite_change';

CREATE TABLE "org_invite_link" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "displayTail" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "org_invite_link_pkey" PRIMARY KEY ("id")
);

-- A redemption outlives membership removal. This prevents a removed account
-- from using the same still-shared link to add itself back to the organization.
CREATE TABLE "org_invite_redemption" (
  "inviteLinkId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "redeemedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "org_invite_redemption_pkey" PRIMARY KEY ("inviteLinkId", "userId")
);

CREATE UNIQUE INDEX "org_invite_link_orgId_key" ON "org_invite_link"("orgId");
CREATE UNIQUE INDEX "org_invite_link_tokenHash_key" ON "org_invite_link"("tokenHash");
CREATE INDEX "org_invite_redemption_userId_idx" ON "org_invite_redemption"("userId");

ALTER TABLE "org_invite_link"
  ADD CONSTRAINT "org_invite_link_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_invite_link"
  ADD CONSTRAINT "org_invite_link_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "org_invite_redemption"
  ADD CONSTRAINT "org_invite_redemption_inviteLinkId_fkey"
  FOREIGN KEY ("inviteLinkId") REFERENCES "org_invite_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_invite_redemption"
  ADD CONSTRAINT "org_invite_redemption_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
