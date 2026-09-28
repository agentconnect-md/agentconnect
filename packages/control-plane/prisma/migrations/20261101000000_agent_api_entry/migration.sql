-- The chat APIs an agent accepts calls on, added under its Integrations (shared-bot-relay.md §10.4).

-- AlterEnum
ALTER TYPE "AuditKind" ADD VALUE 'agent_api_change';

-- CreateEnum
CREATE TYPE "AgentApiProtocol" AS ENUM ('ai-sdk-ui');

-- CreateTable
CREATE TABLE "agent_api_entry" (
    "agentId" UUID NOT NULL,
    "protocol" "AgentApiProtocol" NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_api_entry_pkey" PRIMARY KEY ("agentId","protocol")
);

-- AddForeignKey
ALTER TABLE "agent_api_entry" ADD CONSTRAINT "agent_api_entry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
