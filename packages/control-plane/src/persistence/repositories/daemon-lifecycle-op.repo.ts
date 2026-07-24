/**
 * PgDaemonLifecycleOpRepo — `DaemonLifecycleOpRepo` over Prisma (cli-daemon-split.md §7).
 *
 * Tracks a CP-commanded daemon restart/upgrade in flight. A console command opens a
 * `pending` row (the partial unique index `daemon_lifecycle_op_daemon_pending_uq`
 * enforces at most one per daemon — a second open throws P2002, mapped to 409 at the
 * route), and the row is closed out-of-band by the register→READY closure or a decline.
 */
import type { DaemonLifecycleOp } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  DaemonLifecycleOpRepo,
  DaemonLifecycleOpRecord,
  DaemonLifecycleOpType,
  DaemonLifecycleOpStatus,
  OpenLifecycleOpInput
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
    settledAt: o.settledAt
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

  async expireOverdue(now: Date, daemonId?: DaemonId): Promise<number> {
    const res = await this.db.daemonLifecycleOp.updateMany({
      where: { status: 'pending', deadline: { lt: now }, ...(daemonId ? { daemonId } : {}) },
      data: {
        status: 'failed',
        outcome: 'timed out — the daemon did not re-register before the deadline',
        settledAt: now
      }
    })
    return res.count
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
