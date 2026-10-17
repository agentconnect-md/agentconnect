-- Event wake for follow-ups (assistant-mode.md §5.14): what each follow-up watches and its pending wake.
CREATE TABLE "follow_up_watch" (
    "agentId" UUID NOT NULL,
    "followUpId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "installationId" BIGINT,
    "bindingId" TEXT NOT NULL DEFAULT '',
    "host" TEXT NOT NULL,
    "repoId" BIGINT NOT NULL,
    "subject" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "repoPath" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "wakeSeq" INTEGER NOT NULL DEFAULT 0,
    "pendingSince" TIMESTAMPTZ(6),
    "pendingStateSince" TIMESTAMPTZ(6),
    "pendingLatestAt" TIMESTAMPTZ(6),
    "pendingKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueAt" TIMESTAMPTZ(6),
    "endedReason" TEXT,
    "lastWakeAt" TIMESTAMPTZ(6),
    "lastWakeKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "claimOwner" UUID,
    "claimUntil" TIMESTAMPTZ(6),

    CONSTRAINT "follow_up_watch_pkey" PRIMARY KEY ("agentId","followUpId")
);

CREATE INDEX "follow_up_watch_object_idx" ON "follow_up_watch"("orgId", "provider", "bindingId", "repoId", "subject", "number");

CREATE INDEX "follow_up_watch_due_idx" ON "follow_up_watch"("dueAt", "claimUntil");

ALTER TABLE "follow_up_watch" ADD CONSTRAINT "follow_up_watch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "follow_up_watch_delivery" (
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL DEFAULT '',
    "repoId" BIGINT NOT NULL,
    "subject" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "follow_up_watch_delivery_pkey" PRIMARY KEY ("orgId","provider","bindingId","repoId","subject","number","deliveryKey")
);

CREATE INDEX "follow_up_watch_delivery_received_idx" ON "follow_up_watch_delivery"("receivedAt");
