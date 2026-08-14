-- K8s duty ledger: one claimable row per connected component of the
-- agent↔daemon-held-bot graph, plus its derived membership projection.
CREATE TABLE "duty_group" (
    "id" UUID NOT NULL,
    "orgId" TEXT NOT NULL,
    "holder" UUID,
    "term" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "duty_group_pkey" PRIMARY KEY ("id")
);

CREATE TYPE "DutyMemberKind" AS ENUM ('agent', 'bot');

CREATE TABLE "duty_group_member" (
    "kind" "DutyMemberKind" NOT NULL,
    "refId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "orgId" TEXT NOT NULL,

    CONSTRAINT "duty_group_member_pkey" PRIMARY KEY ("kind","refId")
);

CREATE INDEX "duty_group_orgId_idx" ON "duty_group"("orgId");
CREATE INDEX "duty_group_holder_idx" ON "duty_group"("holder");
CREATE INDEX "duty_group_expiresAt_idx" ON "duty_group"("expiresAt");
CREATE INDEX "duty_group_member_groupId_idx" ON "duty_group_member"("groupId");
CREATE INDEX "duty_group_member_orgId_idx" ON "duty_group_member"("orgId");

ALTER TABLE "duty_group" ADD CONSTRAINT "duty_group_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "duty_group_member" ADD CONSTRAINT "duty_group_member_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "duty_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
