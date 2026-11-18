-- A membership granted by a first sign-in through an organization's connection (docs/designs/organization-sso.md §4.3).
CREATE TABLE "org_sso_join" (
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_sso_join_pkey" PRIMARY KEY ("orgId", "userId")
);

CREATE INDEX "org_sso_join_userId_idx" ON "org_sso_join"("userId");

ALTER TABLE "org_sso_join" ADD CONSTRAINT "org_sso_join_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "org_sso_join" ADD CONSTRAINT "org_sso_join_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
