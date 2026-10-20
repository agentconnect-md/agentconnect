-- Stored Computer screenshots (computer-use.md §9): the reference, hash and size; the bytes live in the object store.
-- CreateTable
CREATE TABLE "computer_screenshot" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "computerId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "takenAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "computer_screenshot_pkey" PRIMARY KEY ("id")
);

-- Screenshot bytes written per organization and UTC day, for metering.
-- CreateTable
CREATE TABLE "computer_screenshot_usage" (
    "orgId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "computer_screenshot_usage_pkey" PRIMARY KEY ("orgId","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "computer_screenshot_computerId_sessionId_sha256_key" ON "computer_screenshot"("computerId", "sessionId", "sha256");

-- CreateIndex
CREATE INDEX "computer_screenshot_orgId_sessionId_takenAt_idx" ON "computer_screenshot"("orgId", "sessionId", "takenAt");

-- CreateIndex
CREATE INDEX "computer_screenshot_expiresAt_idx" ON "computer_screenshot"("expiresAt");

-- CreateIndex
CREATE INDEX "computer_screenshot_computerId_idx" ON "computer_screenshot"("computerId");
