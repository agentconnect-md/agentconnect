-- Capability requests (capability-requests.md §4.3): what an agent asked for, the conversations waiting for it, and their wakes.
CREATE TABLE "capability_request" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "want" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "differs" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "settledBy" JSONB,
    "settledAt" TIMESTAMPTZ(6),
    "settledRevision" BIGINT,
    "appliedBy" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "capability_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "capability_request_key_idx" ON "capability_request"("agentId", "kind", "target", "status");

CREATE INDEX "capability_request_expiry_idx" ON "capability_request"("status", "expiresAt");

-- One open request per agent and target (§4.1).
CREATE UNIQUE INDEX "capability_request_open_key" ON "capability_request"("agentId", "kind", "target") WHERE "status" = 'open';

ALTER TABLE "capability_request" ADD CONSTRAINT "capability_request_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "capability_request_origin" (
    "requestId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "placeLabel" TEXT,
    "external" BOOLEAN NOT NULL DEFAULT false,
    "askers" JSONB NOT NULL,
    "askedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wakeGeneration" INTEGER NOT NULL DEFAULT 0,
    "wakeState" TEXT NOT NULL DEFAULT 'none',
    "wakeAttempts" INTEGER NOT NULL DEFAULT 0,
    "wakeReason" TEXT,
    "wakeSince" TIMESTAMPTZ(6),
    "wakeDueAt" TIMESTAMPTZ(6),
    "claimOwner" UUID,
    "claimUntil" TIMESTAMPTZ(6),

    CONSTRAINT "capability_request_origin_pkey" PRIMARY KEY ("requestId","sessionId")
);

CREATE INDEX "capability_request_origin_session_idx" ON "capability_request_origin"("sessionId");

CREATE INDEX "capability_request_origin_wake_idx" ON "capability_request_origin"("wakeDueAt", "claimUntil");

ALTER TABLE "capability_request_origin" ADD CONSTRAINT "capability_request_origin_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "capability_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
