-- What the linked sign-in methods say about the stored address, so an address nobody proved is never read as verified.
-- "emailVerifiedAt": a method that verifies addresses reports it. "emailSsoConnectorIds": the SSO connectors whose identity asserts it.

-- AlterTable
ALTER TABLE "app_user"
  ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "emailSsoConnectorIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
