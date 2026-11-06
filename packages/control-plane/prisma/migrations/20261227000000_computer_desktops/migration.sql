-- Per-agent desktops (computer-use.md §3.9): leases, the wait queue and audit entries per desktop of a Computer.
ALTER TABLE "computer" ADD COLUMN "desktops" JSONB;

ALTER TABLE "computer_lease" ADD COLUMN "desktop" TEXT NOT NULL DEFAULT '';
ALTER TABLE "computer_lease" DROP CONSTRAINT "computer_lease_pkey";
ALTER TABLE "computer_lease" ADD CONSTRAINT "computer_lease_pkey" PRIMARY KEY ("computerId", "desktop");

ALTER TABLE "computer_lease_waiter" ADD COLUMN "desktop" TEXT NOT NULL DEFAULT '';
ALTER TABLE "computer_lease_waiter" DROP CONSTRAINT "computer_lease_waiter_pkey";
ALTER TABLE "computer_lease_waiter" ADD CONSTRAINT "computer_lease_waiter_pkey" PRIMARY KEY ("computerId", "desktop", "agentId", "sessionId");

ALTER TABLE "computer_audit" ADD COLUMN "desktop" TEXT;
