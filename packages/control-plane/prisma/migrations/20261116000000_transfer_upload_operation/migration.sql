-- A begun workspace upload is an operation the console polls: its ticket records the agent, the path and the outcome.
ALTER TABLE "transfer_upload_ticket"
    ADD COLUMN "agentId" TEXT,
    ADD COLUMN "path" TEXT,
    ADD COLUMN "outcome" JSONB,
    ADD COLUMN "settledAt" TIMESTAMPTZ(6);

CREATE INDEX "transfer_upload_ticket_objectKey_idx" ON "transfer_upload_ticket"("objectKey");
