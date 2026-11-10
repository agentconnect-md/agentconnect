-- CreateTable
CREATE TABLE "wechat_pending_login" (
    "id" UUID NOT NULL,
    "targetKey" TEXT,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "botId" UUID,
    "requestedName" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "qrcode" TEXT,
    "qrUrl" TEXT,
    "pollHost" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureReason" TEXT,
    "botToken" TEXT,
    "ilinkBotId" TEXT,
    "ilinkUserId" TEXT,
    "baseUrl" TEXT,
    "integrationId" UUID,
    "resultBotId" UUID,
    "claimToken" UUID,
    "claimedUntil" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "wechat_pending_login_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wechat_pending_login_targetKey_key" ON "wechat_pending_login"("targetKey");

-- CreateIndex
CREATE INDEX "wechat_pending_login_createdAt_idx" ON "wechat_pending_login"("createdAt");
