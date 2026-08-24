-- Provider-neutral formal-review publication lease, its single-use operation
-- ledger, and the body-free attempt outcome store (gitlab-com-integration.md
-- §15.1, §15.2). Every agent on a project publishes through ONE service account
-- and the provider's bulk-publish endpoint has no attempt identifier, so the
-- lease is a correctness boundary: compare-and-swap acquisition, a monotonic
-- fence, and one owner across agents and daemons.

CREATE TABLE "code_host_review_lease" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "projectExternalId" BIGINT NOT NULL,
    "mergeRequestIid" INTEGER NOT NULL,
    "serviceAccountExternalId" BIGINT NOT NULL,
    "fence" BIGINT NOT NULL DEFAULT 0,
    "attemptId" UUID,
    "ownerDaemonId" UUID,
    "agentId" UUID,
    "hookId" UUID,
    "deliveryKey" TEXT,
    "event" TEXT,
    "verdict" TEXT,
    "headSha" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'settled',
    "leaseUntil" TIMESTAMPTZ(6),
    "lockedReason" TEXT,
    "lockedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "code_host_review_lease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_host_review_lease_attemptId_key" ON "code_host_review_lease"("attemptId");
-- The subject key is the provider-side merge request, not the organization: the
-- global project claim already gives one project exactly one owning org.
CREATE UNIQUE INDEX "code_host_review_lease_subject_key" ON "code_host_review_lease"("provider", "projectExternalId", "mergeRequestIid", "serviceAccountExternalId");
CREATE INDEX "code_host_review_lease_orgId_idx" ON "code_host_review_lease"("orgId");
CREATE INDEX "code_host_review_lease_phase_leaseUntil_idx" ON "code_host_review_lease"("phase", "leaseUntil");

ALTER TABLE "code_host_review_lease" ADD CONSTRAINT "code_host_review_lease_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "code_host_review_operation" (
    "id" UUID NOT NULL,
    "leaseId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "attemptId" UUID NOT NULL,
    "fence" BIGINT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'issued',
    "startToken" UUID,
    "responseStatus" INTEGER,
    "responseExternalId" TEXT,
    "resultCode" TEXT,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(6),
    "ambiguousAt" TIMESTAMPTZ(6),
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "code_host_review_operation_pkey" PRIMARY KEY ("id")
);

-- One permit per (attempt, fence, kind, ordinal); method and target are compared
-- on an idempotent re-issue, so the binding of §15.1 holds without a wide index.
CREATE UNIQUE INDEX "code_host_review_operation_permit_key" ON "code_host_review_operation"("attemptId", "fence", "kind", "ordinal");
CREATE INDEX "code_host_review_operation_leaseId_state_idx" ON "code_host_review_operation"("leaseId", "state");
CREATE INDEX "code_host_review_operation_orgId_idx" ON "code_host_review_operation"("orgId");

ALTER TABLE "code_host_review_operation" ADD CONSTRAINT "code_host_review_operation_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "code_host_review_lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "code_host_review_attempt_outcome" (
    "attemptId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "hookId" UUID NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "projectExternalId" BIGINT NOT NULL,
    "mergeRequestIid" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "externalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "code_host_review_attempt_outcome_pkey" PRIMARY KEY ("attemptId")
);

CREATE INDEX "code_host_review_attempt_outcome_orgId_idx" ON "code_host_review_attempt_outcome"("orgId");
CREATE INDEX "code_host_review_attempt_outcome_hookId_deliveryKey_idx" ON "code_host_review_attempt_outcome"("hookId", "deliveryKey");

ALTER TABLE "code_host_review_attempt_outcome" ADD CONSTRAINT "code_host_review_attempt_outcome_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
