// PgComputerLeaseRepo — the `computer_lease` row, changed only under the Computer row's lock (computer-use.md §4.4).
import type { ComputerLease, ComputerLeaseWaiter } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { ComputerLeaseRepo } from '../ports.js'
import type { ComputerId, OrgId } from '../../domain/ids.js'
import { readAgentAccess, readComputerPolicy } from '../../domain/computer.js'
import type { ControlLease, LeaseComputer, LeaseStep } from '../../domain/computerLease.js'
import type { LeaseWaiter } from '../../domain/computerLeaseQueue.js'

function toLease(row: ComputerLease): ControlLease {
  return {
    leaseId: row.leaseId,
    computerId: row.computerId,
    orgId: row.orgId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    agentName: row.agentName,
    daemonId: row.daemonId,
    acquiredAt: row.acquiredAt.getTime(),
    lastUsedAt: row.lastUsedAt.getTime(),
    renewedAt: row.renewedAt.getTime(),
    turnAt: row.turnAt.getTime(),
    spentAt: row.spentAt?.getTime() ?? null
  }
}

function toRow(lease: ControlLease) {
  return {
    orgId: lease.orgId,
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    agentId: lease.agentId,
    agentName: lease.agentName,
    daemonId: lease.daemonId,
    acquiredAt: new Date(lease.acquiredAt),
    lastUsedAt: new Date(lease.lastUsedAt),
    renewedAt: new Date(lease.renewedAt),
    turnAt: new Date(lease.turnAt),
    spentAt: lease.spentAt === null ? null : new Date(lease.spentAt)
  }
}

function toWaiter(row: ComputerLeaseWaiter): LeaseWaiter {
  return {
    computerId: row.computerId,
    orgId: row.orgId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    daemonId: row.daemonId,
    enqueuedAt: row.enqueuedAt.getTime(),
    polledAt: row.polledAt.getTime(),
    turnAt: row.turnAt.getTime(),
    droppedAt: row.droppedAt?.getTime() ?? null
  }
}

function waiterRow(w: LeaseWaiter) {
  return {
    orgId: w.orgId,
    daemonId: w.daemonId,
    enqueuedAt: new Date(w.enqueuedAt),
    polledAt: new Date(w.polledAt),
    turnAt: new Date(w.turnAt),
    droppedAt: w.droppedAt === null ? null : new Date(w.droppedAt)
  }
}

const waiterKey = (w: { agentId: string; sessionId: string }) => `${w.agentId}/${w.sessionId}`

export class PgComputerLeaseRepo implements ComputerLeaseRepo {
  constructor(private readonly db: PrismaLike) {}

  async get(computerId: ComputerId): Promise<ControlLease | null> {
    const row = await this.db.computerLease.findUnique({ where: { computerId } })
    return row ? toLease(row) : null
  }

  async step<R>(
    orgId: OrgId,
    computerId: ComputerId,
    decide: (computer: LeaseComputer | null, lease: ControlLease | null, queue: LeaseWaiter[]) => LeaseStep<R>
  ): Promise<R> {
    return withAmbientTx(this.db, async (tx) => {
      // The Computer row lock serializes every lease change across replicas; a foreign or missing id locks nothing.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "computer" WHERE "id" = ${computerId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      const computer =
        locked.length === 1
          ? await tx.computer.findUnique({
              where: { id: computerId },
              select: {
                status: true,
                lastSeenAt: true,
                policy: true,
                agentAccess: true,
                accessAgentIds: true,
                ownerUserId: true,
                stoppedAt: true,
                poolSessionId: true
              }
            })
          : null
      const row = computer ? await tx.computerLease.findUnique({ where: { computerId } }) : null
      const waiting = computer ? (await tx.computerLeaseWaiter.findMany({ where: { computerId } })).map(toWaiter) : []
      const view: LeaseComputer | null = computer
        ? {
            status: computer.status,
            lastSeenAt: computer.lastSeenAt,
            stoppedAt: computer.stoppedAt,
            poolSessionId: computer.poolSessionId,
            policy: readComputerPolicy(computer.policy, computer.ownerUserId),
            agentAccess: readAgentAccess(computer.agentAccess, computer.accessAgentIds)
          }
        : null
      const { next, queue, result } = decide(view, row ? toLease(row) : null, waiting)
      if (next === null && row) await tx.computerLease.delete({ where: { computerId } })
      if (next) {
        const data = toRow(next)
        await tx.computerLease.upsert({ where: { computerId }, create: { computerId, ...data }, update: data })
      }
      if (queue) await this.storeQueue(tx, computerId, waiting, queue)
      return result
    })
  }

  async listBySession(sessionId: string): Promise<ControlLease[]> {
    const rows = await this.db.computerLease.findMany({ where: { sessionId } })
    return rows.map(toLease)
  }

  async listWaitingBySession(sessionId: string): Promise<LeaseWaiter[]> {
    const rows = await this.db.computerLeaseWaiter.findMany({ where: { sessionId } })
    return rows.map(toWaiter)
  }

  // Write only the waiters that changed: a queue is a handful of rows.
  private async storeQueue(tx: PrismaLike, computerId: ComputerId, before: LeaseWaiter[], after: LeaseWaiter[]) {
    const kept = new Set(after.map(waiterKey))
    for (const gone of before.filter((w) => !kept.has(waiterKey(w)))) {
      await tx.computerLeaseWaiter.delete({
        where: { computerId_agentId_sessionId: { computerId, agentId: gone.agentId, sessionId: gone.sessionId } }
      })
    }
    const was = new Map(before.map((w) => [waiterKey(w), JSON.stringify(w)]))
    for (const w of after.filter((x) => was.get(waiterKey(x)) !== JSON.stringify(x))) {
      const data = waiterRow(w)
      await tx.computerLeaseWaiter.upsert({
        where: { computerId_agentId_sessionId: { computerId, agentId: w.agentId, sessionId: w.sessionId } },
        create: { computerId, agentId: w.agentId, sessionId: w.sessionId, ...data },
        update: data
      })
    }
  }

  async renewByDaemon(daemonId: string, at: Date, aliveSince: Date): Promise<number> {
    // A holder already lost stays lost: only a lease renewed since `aliveSince` is carried forward.
    const { count } = await this.db.computerLease.updateMany({
      where: { daemonId, renewedAt: { gt: aliveSince } },
      data: { renewedAt: at }
    })
    return count
  }
}
