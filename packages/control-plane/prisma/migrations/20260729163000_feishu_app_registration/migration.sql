CREATE TYPE "FeishuAppRegistrationStatus" AS ENUM (
  'pending',
  'authorized',
  'completed',
  'failed'
);

CREATE TABLE "feishu_app_registration" (
  "id" UUID NOT NULL,
  "targetKey" TEXT,
  "orgId" TEXT NOT NULL,
  "agentId" UUID NOT NULL,
  "requestedName" TEXT,
  "fallbackRegion" TEXT NOT NULL,
  "authorizationUrl" TEXT NOT NULL,
  "providerDomain" TEXT NOT NULL,
  "deviceCode" TEXT,
  "intervalMs" INTEGER NOT NULL,
  "nextPollAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "status" "FeishuAppRegistrationStatus" NOT NULL DEFAULT 'pending',
  "failureReason" TEXT,
  "appId" TEXT,
  "appSecret" TEXT,
  "resolvedRegion" TEXT,
  "botId" UUID NOT NULL,
  "integrationId" UUID NOT NULL,
  "createdByUserId" TEXT,
  "claimToken" UUID,
  "claimedUntil" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMPTZ(6),

  CONSTRAINT "feishu_app_registration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feishu_app_registration_targetKey_key"
  ON "feishu_app_registration"("targetKey");

CREATE INDEX "feishu_app_registration_status_nextPollAt_idx"
  ON "feishu_app_registration"("status", "nextPollAt");
