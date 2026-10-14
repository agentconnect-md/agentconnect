-- Console file-transfer upload tickets move from process memory to PostgreSQL so any CP replica can sign.
CREATE TABLE "transfer_upload_ticket" (
    "id" UUID NOT NULL,
    "daemonId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transfer_upload_ticket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transfer_upload_ticket_expiresAt_idx" ON "transfer_upload_ticket"("expiresAt");
