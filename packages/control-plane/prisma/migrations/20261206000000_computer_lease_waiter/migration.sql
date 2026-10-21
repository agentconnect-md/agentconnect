-- The FIFO lease wait queue for shared Computers (computer-use.md §4.4).
CREATE TABLE "computer_lease_waiter" (
    "computerId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "daemonId" UUID,
    "enqueuedAt" TIMESTAMPTZ(3) NOT NULL,
    "polledAt" TIMESTAMPTZ(3) NOT NULL,
    "turnAt" TIMESTAMPTZ(3) NOT NULL,
    "droppedAt" TIMESTAMPTZ(3),

    CONSTRAINT "computer_lease_waiter_pkey" PRIMARY KEY ("computerId","agentId","sessionId")
);

CREATE INDEX "computer_lease_waiter_sessionId_idx" ON "computer_lease_waiter"("sessionId");

ALTER TABLE "computer_lease_waiter" ADD CONSTRAINT "computer_lease_waiter_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
