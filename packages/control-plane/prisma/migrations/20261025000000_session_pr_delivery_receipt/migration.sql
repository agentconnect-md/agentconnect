-- PR feedback delivery receipts: a redelivered GitHub event reuses its GUID and must not wake its session again.
CREATE TABLE "session_pull_request_delivery" (
  "orgId" TEXT NOT NULL,
  "deliveryKey" TEXT NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "session_pull_request_delivery_pkey" PRIMARY KEY ("orgId", "deliveryKey")
);

CREATE INDEX "session_pull_request_delivery_received_idx"
  ON "session_pull_request_delivery"("receivedAt");
