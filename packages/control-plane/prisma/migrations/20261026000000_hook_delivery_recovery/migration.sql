-- Durable per-GUID count of redeliveries for GitHub deliveries that landed no run, so a restart cannot reset the cap.
CREATE TABLE "hook_delivery_recovery" (
  "deliveryKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "lastRequestedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "hook_delivery_recovery_pkey" PRIMARY KEY ("deliveryKey")
);

CREATE INDEX "hook_delivery_recovery_requested_idx"
  ON "hook_delivery_recovery"("lastRequestedAt");
