-- A membership can be suspended without being removed, and records who manages it.
CREATE TYPE "MembershipSource" AS ENUM ('manual', 'directory');

ALTER TABLE "membership"
  ADD COLUMN "suspendedAt" TIMESTAMPTZ(6),
  ADD COLUMN "suspendedBy" "MembershipSource",
  ADD COLUMN "managedBy" "MembershipSource" NOT NULL DEFAULT 'manual',
  ADD COLUMN "directoryExternalId" TEXT;

CREATE UNIQUE INDEX "membership_orgId_directoryExternalId_key" ON "membership"("orgId", "directoryExternalId");
