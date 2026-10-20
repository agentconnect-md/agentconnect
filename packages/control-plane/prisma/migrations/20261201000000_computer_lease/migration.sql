-- The one control lease a Computer may have (computer-use.md §4.4).
CREATE TABLE "computer_lease" (
    "computerId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "leaseId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "agentName" TEXT,
    "daemonId" UUID,
    "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL,
    "renewedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "computer_lease_pkey" PRIMARY KEY ("computerId")
);

CREATE INDEX "computer_lease_sessionId_idx" ON "computer_lease"("sessionId");
CREATE INDEX "computer_lease_daemonId_idx" ON "computer_lease"("daemonId");

ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
