CREATE TYPE "ComputerKind" AS ENUM ('self-hosted', 'managed');
CREATE TYPE "ComputerIsolation" AS ENUM ('none', 'container', 'vm');
CREATE TYPE "ComputerOs" AS ENUM ('macos', 'windows', 'linux');
CREATE TYPE "ComputerSession" AS ENUM ('aqua', 'console', 'rdp', 'x11', 'xvfb', 'wayland-gnome');
CREATE TYPE "ComputerStatus" AS ENUM ('online', 'offline', 'locked', 'paused', 'human_in_control', 'busy', 'revoked');
ALTER TYPE "PrincipalType" ADD VALUE 'computer';
ALTER TYPE "AuditKind" ADD VALUE 'computer_change';

CREATE TABLE "computer" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "kind" "ComputerKind" NOT NULL DEFAULT 'self-hosted',
    "isolation" "ComputerIsolation" NOT NULL DEFAULT 'none',
    "os" "ComputerOs" NOT NULL,
    "osVersion" TEXT NOT NULL,
    "session" "ComputerSession" NOT NULL,
    "status" "ComputerStatus" NOT NULL DEFAULT 'offline',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "desktopDaemonVersion" TEXT NOT NULL,
    "driverVersion" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
    "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "computer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "computer_selected_audience_nonempty" CHECK ("visibility" <> 'restricted' OR cardinality("sharedWith") > 0)
);
CREATE INDEX "computer_orgId_idx" ON "computer"("orgId");
CREATE INDEX "computer_ownerUserId_idx" ON "computer"("ownerUserId");
CREATE INDEX "computer_sharedWith_idx" ON "computer" USING GIN ("sharedWith");
ALTER TABLE "computer" ADD CONSTRAINT "computer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer" ADD CONSTRAINT "computer_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "computer_registration" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "displayTail" TEXT NOT NULL,
    "name" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "computerId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "computer_registration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "computer_registration_hash_key" ON "computer_registration"("hash");
CREATE INDEX "computer_registration_orgId_idx" ON "computer_registration"("orgId");
CREATE INDEX "computer_registration_expiresAt_idx" ON "computer_registration"("expiresAt");
ALTER TABLE "computer_registration" ADD CONSTRAINT "computer_registration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_registration" ADD CONSTRAINT "computer_registration_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "computer_registration" ADD CONSTRAINT "computer_registration_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "api_key" ADD COLUMN "computerId" UUID;
CREATE INDEX "api_key_computerId_idx" ON "api_key"("computerId");
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
