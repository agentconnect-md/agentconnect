-- One row per call a desktop daemon served (computer-use.md §8.2); typed text is kept by its length only.
-- CreateTable
CREATE TABLE "computer_audit" (
    "computerId" UUID NOT NULL,
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "tool" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "agentId" UUID,
    "sessionId" TEXT,
    "outcome" TEXT NOT NULL,
    "code" TEXT,
    "approval" TEXT,
    "args" JSONB NOT NULL DEFAULT '{}',
    "textLength" INTEGER,
    "ms" INTEGER NOT NULL,
    "screenshotRef" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "computer_audit_pkey" PRIMARY KEY ("computerId","id")
);

-- CreateIndex
CREATE INDEX "computer_audit_computerId_at_idx" ON "computer_audit"("computerId", "at" DESC);

-- AddForeignKey
ALTER TABLE "computer_audit" ADD CONSTRAINT "computer_audit_computerId_fkey" FOREIGN KEY ("computerId") REFERENCES "computer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

