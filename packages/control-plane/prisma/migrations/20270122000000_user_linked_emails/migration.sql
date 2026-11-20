-- Every address the linked sign-in methods report, so mail from any of a member's own addresses names that member.
-- "linkedEmails": methods that verify addresses. "tenantEmails": Microsoft identities, whose tenant sets the address.

-- AlterTable
ALTER TABLE "app_user"
  ADD COLUMN "linkedEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "tenantEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
