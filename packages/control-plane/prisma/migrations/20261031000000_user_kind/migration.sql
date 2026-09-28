-- Service-account members: an org member that never signs in and whose keys an owner mints (daemon-api-key-auth.md §6).

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('human', 'service_account');

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN "kind" "UserKind" NOT NULL DEFAULT 'human';
