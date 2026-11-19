-- When a linked social sign-in method last vouched for the stored address; null until one does, so an address only an SSO connection supplied is never read as verified.

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(6);
