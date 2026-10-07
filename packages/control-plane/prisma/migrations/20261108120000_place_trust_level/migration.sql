-- A place's trust level (assistant-mode.md §5.3): what an editor declared, what the platform detected, and when it last changed.
-- Existing rows stay undeclared, which the daemon reads as external.
CREATE TYPE "PlaceTrustLevel" AS ENUM ('internal', 'external');

ALTER TABLE "integration_channel" ADD COLUMN "trustDeclared" "PlaceTrustLevel",
ADD COLUMN "trustDetected" "PlaceTrustLevel",
ADD COLUMN "trustDetectedReason" TEXT,
ADD COLUMN "trustChangedAt" TIMESTAMPTZ(6);
