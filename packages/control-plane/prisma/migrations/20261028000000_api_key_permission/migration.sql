-- Key permissions and agent selection (daemon-api-key-auth.md §6): what a key may do, and which agents an agent-level permission reaches. Existing rows default to full.

-- CreateEnum
CREATE TYPE "ApiKeyPermission" AS ENUM ('full', 'read', 'agent:chat');

-- AlterTable
ALTER TABLE "api_key" ADD COLUMN     "allAgents" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "permission" "ApiKeyPermission" NOT NULL DEFAULT 'full';

-- CreateTable
CREATE TABLE "api_key_agent" (
    "apiKeyId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,

    CONSTRAINT "api_key_agent_pkey" PRIMARY KEY ("apiKeyId","agentId")
);

-- CreateIndex
CREATE INDEX "api_key_agent_agentId_idx" ON "api_key_agent"("agentId");

-- AddForeignKey
ALTER TABLE "api_key_agent" ADD CONSTRAINT "api_key_agent_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_key"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_agent" ADD CONSTRAINT "api_key_agent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
