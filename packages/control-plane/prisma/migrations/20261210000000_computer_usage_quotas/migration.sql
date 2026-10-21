-- Managed computer metering, viewer sessions, quotas and egress (computer-use.md §15.4, §15.5).
ALTER TABLE "computer" ADD COLUMN "poolMeteredAt" TIMESTAMPTZ(6);

CREATE TABLE "computer_usage" (
    "orgId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "computerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "allocation" TEXT,
    "runningSeconds" INTEGER NOT NULL DEFAULT 0,
    "sleepingSeconds" INTEGER NOT NULL DEFAULT 0,
    "volumeGibSeconds" BIGINT NOT NULL DEFAULT 0,
    "relayedBytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "computer_usage_pkey" PRIMARY KEY ("orgId","day","computerId")
);

CREATE TABLE "computer_viewer_session" (
    "computerId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "computer_viewer_session_pkey" PRIMARY KEY ("computerId","userId")
);

CREATE INDEX "computer_viewer_session_orgId_expiresAt_idx" ON "computer_viewer_session"("orgId", "expiresAt");

CREATE TABLE "computer_org_settings" (
    "orgId" TEXT NOT NULL,
    "quotas" JSONB,
    "egress" JSONB,
    "egressProxyPassword" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "computer_org_settings_pkey" PRIMARY KEY ("orgId")
);

ALTER TABLE "computer_org_settings" ADD CONSTRAINT "computer_org_settings_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
