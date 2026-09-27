-- The provider user id of a console user's linked Google identity, which a Google Chat `users/{id}` names (google-chat-integration.md §10.6).

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN "googleAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "app_user_googleAccountId_key" ON "app_user"("googleAccountId");
