-- The API key that opened a conversation through the agent chat API, so the console names the session by it (shared-bot-relay.md §10.4).

-- AlterTable
ALTER TABLE "webchat_conversation" ADD COLUMN "apiKeyId" TEXT;

-- CreateIndex
CREATE INDEX "webchat_conversation_apiKeyId_idx" ON "webchat_conversation"("apiKeyId");

-- AddForeignKey
ALTER TABLE "webchat_conversation" ADD CONSTRAINT "webchat_conversation_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id") ON DELETE SET NULL ON UPDATE CASCADE;
