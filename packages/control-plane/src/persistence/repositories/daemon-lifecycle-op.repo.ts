/**
 * PgDaemonLifecycleOpRepo — `DaemonLifecycleOpRepo` over Prisma (cli-daemon-split.md §7).
 *
 * Tracks a CP-commanded daemon restart/upgrade in flight. A console command opens a
 * `pending` row (the partial unique index `daemon_lifecycle_op_daemon_pending_uq`
 * enforces at most one per daemon — a second open throws P2002, mapped to 409 at the
 * route), and the row is closed out-of-band by the register→READY closure or a decline.
 */
import type { DaemonLifecycleOp } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  DaemonLifecycleOpRepo,
  DaemonLifecycleOpRecord,
  DaemonLifecycleOpType,
  DaemonLifecycleOpStatus,
  OpenLifecycleOpInput,
  OverdueUpgradeCompensation
} from '../ports.js'
import { DaemonId } from '../../domain/ids.js'

function toRecord(o: DaemonLifecycleOp): DaemonLifecycleOpRecord {
  return {
    id: o.id,
    daemonId: DaemonId(o.daemonId),
    op: o.op as DaemonLifecycleOpType,
    targetVersion: o.targetVersion,
    initiator: o.initiator,
    status: o.status as DaemonLifecycleOpStatus,
    commandEpoch: o.commandEpoch,
    acceptedAt: o.acceptedAt,
    startedAt: o.startedAt,
    deadline: o.deadline,
    outcome: o.outcome,
    settledAt: o.settledAt,
    commandImage: o.commandImage,
    rollbackImage: o.rollbackImage
  }
}

export class PgDaemonLifecycleOpRepo implements DaemonLifecycleOpRepo {
  constructor(private readonly db: PrismaLike) {}

  async open(input: OpenLifecycleOpInput): Promise<DaemonLifecycleOpRecord> {
    const row = await this.db.daemonLifecycleOp.create({
      data: {
        daemonId: input.daemonId,
        op: input.op,
        targetVersion: input.targetVersion ?? null,
        initiator: input.initiator ?? null,
        commandEpoch: input.commandEpoch,
        deadline: input.deadline,
        commandImage: input.commandImage ?? null,
        rollbackImage: input.rollbackImage ?? null,
        status: 'pending'
      }
    })
    return toRecord(row)
  }

  async markAccepted(id: string, at: Date, commandEpoch: bigint): Promise<void> {
    // Arm only a still-pending row (a decline/expiry already terminal must stay terminal).
    // Persist the exact sent epoch here — the pre-send `open()` value was only an estimate.
    await this.db.daemonLifecycleOp.updateMany({
      where: { id, status: 'pending' },
      data: { acceptedAt: at, commandEpoch }
    })
  }

  async getById(id: string): Promise<DaemonLifecycleOpRecord | null> {
    const row = await this.db.daemonLifecycleOp.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async pendingForDaemon(daemonId: DaemonId): Promise<DaemonLifecycleOpRecord | null> {
    const row = await this.db.daemonLifecycleOp.findFirst({
      where: { daemonId, status: 'pending' },
      orderBy: { startedAt: 'desc' }
    })
    return row ? toRecord(row) : null
  }

  async latestForDaemon(daemonId: DaemonId): Promise<DaemonLifecycleOpRecord | null> {
    const row = await this.db.daemonLifecycleOp.findFirst({
      where: { daemonId },
      orderBy: { startedAt: 'desc' }
    })
    return row ? toRecord(row) : null
  }

  async latestForDaemons(daemonIds: DaemonId[]): Promise<DaemonLifecycleOpRecord[]> {
    if (daemonIds.length === 0) return []
    // Newest-first, then keep the first row seen per daemon — the most recent op each.
    const rows = await this.db.daemonLifecycleOp.findMany({
      where: { daemonId: { in: daemonIds } },
      orderBy: { startedAt: 'desc' }
    })
    const seen = new Set<string>()
    const out: DaemonLifecycleOpRecord[] = []
    for (const r of rows) {
      if (seen.has(r.daemonId)) continue
      seen.add(r.daemonId)
      out.push(toRecord(r))
    }
    return out
  }

  /** `commandImage: null` is the exclusion, not an oversight: an op carrying a compensation
   *  obligation may still have its image durable, and reporting it failed here is exactly the
   *  contradiction the obligation exists to prevent. The compensation pass owns those. */
  async expireOverdue(now: Date, daemonId?: DaemonId): Promise<number> {
    const res = await this.db.daemonLifecycleOp.updateMany({
      where: {
        status: 'pending',
        deadline: { lt: now },
        commandImage: null,
        ...(daemonId ? { daemonId } : {})
      },
      data: {
        status: 'failed',
        outcome: 'timed out — the daemon did not re-register before the deadline',
        settledAt: now
      }
    })
    return res.count
  }

  /** Oldest first, so a backlog drains in the order the commands were issued. */
  async listOverdueCompensations(now: Date, limit: number): Promise<OverdueUpgradeCompensation[]> {
    const rows = await this.db.daemonLifecycleOp.findMany({
      where: { status: 'pending', deadline: { lt: now }, commandImage: { not: null } },
      select: {
        id: true,
        daemonId: true,
        commandImage: true,
        rollbackImage: true,
        daemon: { select: { orgId: true } }
      },
      orderBy: { startedAt: 'asc' },
      take: limit
    })
    return rows.flatMap((row) =>
      // Both halves or nothing: half an obligation cannot be discharged, and skipping it
      // leaves the op for a human rather than guessing an image to restore.
      row.commandImage && row.rollbackImage
        ? [
            {
              opId: row.id,
              daemonId: DaemonId(row.daemonId),
              orgId: row.daemon.orgId,
              commandImage: row.commandImage,
              rollbackImage: row.rollbackImage
            }
          ]
        : []
    )
  }

  /** The op transitions FIRST and gates the restore, and both are one transaction — see the
   *  port doc: rolling the image back before settling lets a concurrent READY report success
   *  over an image that was already reverted. */
  async settleWithCompensation(input: {
    opId: string
    orgId: string
    rollbackImage: string
    outcome: string
    at: Date
  }): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      const settled = await tx.daemonLifecycleOp.updateMany({
        where: { id: input.opId, status: 'pending' },
        data: { status: 'failed', outcome: input.outcome, settledAt: input.at }
      })
      if (settled.count === 0) return false
      // Owner-guarded, so this only undoes the write this operation made. A row somebody
      // else now owns is not this operation's to revert, and the op still fails: its image
      // is not the durable desired state either way.
      await tx.orgClusterExecution.updateMany({
        where: { orgId: input.orgId, daemonImageOwner: input.opId },
        data: { daemonImage: input.rollbackImage, daemonImageOwner: null, specRevision: { increment: 1 } }
      })
      return true
    })
  }

  async settle(id: string, status: 'succeeded' | 'failed', outcome: string | null, at: Date): Promise<boolean> {
    // Guard on the current `pending` status so a late register can't overwrite a
    // decline that already failed the op (and vice-versa) — last transition wins.
    const res = await this.db.daemonLifecycleOp.updateMany({
      where: { id, status: 'pending' },
      data: { status, outcome, settledAt: at }
    })
    return res.count > 0
  }
}
