-- CP-commanded daemon restart/upgrade in flight (cli-daemon-split.md §7). A console
-- "Restart"/"Upgrade" opens a `pending` row and sends the C→D lifecycle REQ; the row
-- is closed out-of-band when the daemon drains + re-registers READY (an upgrade also
-- requires its reported agentVersion to reach the target within the deadline), or
-- `failed` on a decline / a deadline lapse.

-- CreateEnum
CREATE TYPE "public"."DaemonLifecycleOpType" AS ENUM ('restart', 'upgrade');

-- CreateEnum
CREATE TYPE "public"."DaemonLifecycleOpStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "public"."daemon_lifecycle_op" (
    "id" TEXT NOT NULL,
    "daemonId" UUID NOT NULL,
    "op" "public"."DaemonLifecycleOpType" NOT NULL,
    "targetVersion" TEXT,
    "initiator" TEXT,
    "status" "public"."DaemonLifecycleOpStatus" NOT NULL DEFAULT 'pending',
    "commandEpoch" BIGINT NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMPTZ(6),
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMPTZ(6) NOT NULL,
    "outcome" TEXT,
    "settledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daemon_lifecycle_op_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daemon_lifecycle_op_daemonId_status_idx" ON "public"."daemon_lifecycle_op"("daemonId" ASC, "status" ASC);

-- CreateIndex
-- At most one op may be pending per daemon (the CP refuses a second command while
-- one is in flight). A partial unique index is not faithfully expressible in the
-- Prisma schema, so keep it hand-edited (mirrors assignment_session_active_uq).
CREATE UNIQUE INDEX "daemon_lifecycle_op_daemon_pending_uq"
    ON "public"."daemon_lifecycle_op"("daemonId" ASC)
    WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "public"."daemon_lifecycle_op" ADD CONSTRAINT "daemon_lifecycle_op_daemonId_fkey" FOREIGN KEY ("daemonId") REFERENCES "public"."daemon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
