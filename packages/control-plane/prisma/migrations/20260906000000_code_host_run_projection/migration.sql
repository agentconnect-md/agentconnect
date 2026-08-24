-- Informational run projection (gitlab-com-integration.md §16): one durable
-- desired-generation row per (hook, project, merge-request IID, head SHA,
-- projection epoch). The Control Plane records the desired generation and the
-- owning daemon is the only provider writer, so `leaseOwner` names a daemon and
-- `writeMarker`/`writePhase` are the in-flight mutation mutex that keeps an
-- ambiguous write fail-closed on that writer. Provider-neutral by design: the
-- GitHub Checks writer stays where it is and this table gets its rules, not its
-- columns. No foreign keys — cleanup must still run after an owner row is gone.

CREATE TABLE "code_host_run_projection" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "hookId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentId" UUID NOT NULL,
    "agentName" TEXT,
    "projectId" BIGINT NOT NULL,
    "projectPath" TEXT NOT NULL,
    "mergeRequestIid" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "projectionEpoch" BIGINT NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 1,
    "currentDeliveryKey" TEXT,
    "currentRunAt" TIMESTAMPTZ(6),
    "externalId" TEXT NOT NULL,
    "noteId" TEXT,
    "desiredState" TEXT NOT NULL,
    "observedState" TEXT,
    "reason" TEXT,
    "sealedThrough" BIGINT NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "sessionId" TEXT,
    "credentialEpoch" BIGINT NOT NULL DEFAULT 1,
    "configRevision" BIGINT,
    "dispatchRevision" BIGINT,
    "dispatchDaemonId" UUID,
    "reviewPolicySnapshot" TEXT,
    "reportingModeSnapshot" TEXT,
    "gateModeSnapshot" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(6),
    "nextAttemptAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "pendingIntent" JSONB,
    "writeMarker" TEXT,
    "writePhase" TEXT,
    "writeStartedAt" TIMESTAMPTZ(6),
    "tombstonedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "code_host_run_projection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_host_run_projection_externalId_key" ON "code_host_run_projection"("externalId");
CREATE UNIQUE INDEX "code_host_run_projection_writeMarker_key" ON "code_host_run_projection"("writeMarker");
CREATE UNIQUE INDEX "code_host_run_projection_hookId_projectId_mergeRequestIid_headSha_projectionEpoch_key" ON "code_host_run_projection"("hookId", "projectId", "mergeRequestIid", "headSha", "projectionEpoch");
CREATE INDEX "code_host_run_projection_orgId_idx" ON "code_host_run_projection"("orgId");
CREATE INDEX "code_host_run_projection_nextAttemptAt_leaseUntil_idx" ON "code_host_run_projection"("nextAttemptAt", "leaseUntil");
CREATE INDEX "code_host_run_projection_hookId_projectId_mergeRequestIid_idx" ON "code_host_run_projection"("hookId", "projectId", "mergeRequestIid");
CREATE INDEX "code_host_run_projection_agentId_idx" ON "code_host_run_projection"("agentId");
