// PgComputerLeaseRepo — the `computer_lease` rows, one per desktop, changed only under the Computer row's lock (§4.4, §3.9).
import type { ComputerLease, ComputerLeaseWaiter } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { ComputerLeaseRepo, LeaseTarget } from '../ports.js'
import type { ComputerId, OrgId } from '../../domain/ids.js'
import {
  desktopStatus,
  leaseDesktopFor,
  readAgentAccess,
  readComputerDesktops,
  readComputerPolicy
} from '../../domain/computer.js'
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
    spentAt: row.spentAt?.getTime() ?? null,
    desktop: row.desktop
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
    droppedAt: row.droppedAt?.getTime() ?? null,
    desktop: row.desktop
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

  async desktops(computerId: ComputerId): Promise<string[]> {
    const rows = await this.db.computerLease.findMany({ where: { computerId }, select: { desktop: true } })
    return rows.map((row) => row.desktop)
  }

  async step<R>(
    orgId: OrgId,
    computerId: ComputerId,
    target: LeaseTarget,
    decide: (
      computer: LeaseComputer | null,
      lease: ControlLease | null,
      queue: LeaseWaiter[],
      desktop: string
    ) => LeaseStep<R>
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
                poolSessionId: true,
                desktops: true
              }
            })
          : null
      // Per-agent desktops (§3.9): each desktop has its own lease and line, and its own status under the main one's.
      const desktops = computer ? readComputerDesktops(computer.desktops) : null
      const desktop = 'desktop' in target ? target.desktop : leaseDesktopFor(desktops, target.agentId)
      const key = { computerId, desktop }
      const row = computer ? await tx.computerLease.findUnique({ where: { computerId_desktop: key } }) : null
      const waiting = computer
        ? (await tx.computerLeaseWaiter.findMany({ where: { computerId, desktop } })).map(toWaiter)
        : []
      const view: LeaseComputer | null = computer
        ? {
            status: desktopStatus(computer.status, desktops, desktop),
            lastSeenAt: computer.lastSeenAt,
            stoppedAt: computer.stoppedAt,
            poolSessionId: computer.poolSessionId,
            policy: readComputerPolicy(computer.policy, computer.ownerUserId),
            agentAccess: readAgentAccess(computer.agentAccess, computer.accessAgentIds)
          }
        : null
      const { next, queue, result } = decide(view, row ? toLease(row) : null, waiting, desktop)
      if (next === null && row) await tx.computerLease.delete({ where: { computerId_desktop: key } })
      if (next) {
        const data = toRow(next)
        await tx.computerLease.upsert({ where: { computerId_desktop: key }, create: { ...key, ...data }, update: data })
      }
      if (queue) await this.storeQueue(tx, computerId, desktop, waiting, queue)
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

  async listOccupancy(computerIds: readonly ComputerId[]): Promise<{ leases: ControlLease[]; waiters: LeaseWaiter[] }> {
    if (computerIds.length === 0) return { leases: [], waiters: [] }
    const ids = [...computerIds]
    const [leases, waiters] = await Promise.all([
      this.db.computerLease.findMany({ where: { computerId: { in: ids } } }),
      this.db.computerLeaseWaiter.findMany({ where: { computerId: { in: ids }, droppedAt: null } })
    ])
    return { leases: leases.map(toLease), waiters: waiters.map(toWaiter) }
  }

  // Write only the waiters that changed: a queue is a handful of rows.
  private async storeQueue(
    tx: PrismaLike,
    computerId: ComputerId,
    desktop: string,
    before: LeaseWaiter[],
    after: LeaseWaiter[]
  ) {
    const kept = new Set(after.map(waiterKey))
    for (const gone of before.filter((w) => !kept.has(waiterKey(w)))) {
      await tx.computerLeaseWaiter.delete({
        where: {
          computerId_desktop_agentId_sessionId: {
            computerId,
            desktop,
            agentId: gone.agentId,
            sessionId: gone.sessionId
          }
        }
      })
    }
    const was = new Map(before.map((w) => [waiterKey(w), JSON.stringify(w)]))
    for (const w of after.filter((x) => was.get(waiterKey(x)) !== JSON.stringify(x))) {
      const data = waiterRow(w)
      const id = { computerId, desktop, agentId: w.agentId, sessionId: w.sessionId }
      await tx.computerLeaseWaiter.upsert({
        where: { computerId_desktop_agentId_sessionId: id },
        create: { ...id, ...data },
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
