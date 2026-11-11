-- CreateTable
CREATE TABLE "msteams_agent_bot_request" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "catalogAppId" TEXT NOT NULL,
    "teamIds" TEXT[],
    "appPackage" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "refreshToken" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMPTZ(6) NOT NULL,
    "claimToken" UUID,
    "claimedUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "msteams_agent_bot_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "msteams_agent_bot_request_orgId_agentId_tenantId_key" ON "msteams_agent_bot_request"("orgId", "agentId", "tenantId");

-- CreateIndex
CREATE INDEX "msteams_agent_bot_request_nextCheckAt_idx" ON "msteams_agent_bot_request"("nextCheckAt");

-- CreateIndex
CREATE INDEX "msteams_agent_bot_request_createdAt_idx" ON "msteams_agent_bot_request"("createdAt");
