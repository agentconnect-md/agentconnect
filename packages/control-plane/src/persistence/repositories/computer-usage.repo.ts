// PgComputerUsageRepo — metered Computer use, live viewings and an organization's computer settings (computer-use.md §15.4, §15.5).
import { Prisma } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  ComputerAccrual,
  ComputerOrgSettingsRecord,
  ComputerUsageRepo,
  ComputerUsageRow,
  ComputerUsageTotals
} from '../ports.js'
import { splitByUtcDay, utcDay } from '../../domain/computerMetering.js'

const json = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue))

const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

const zero = (): ComputerUsageRow => ({ runningSeconds: 0, sleepingSeconds: 0, volumeGibSeconds: 0, relayedBytes: 0 })

function add(into: ComputerUsageRow, row: ComputerUsageRow): void {
  into.runningSeconds += row.runningSeconds
  into.sleepingSeconds += row.sleepingSeconds
  into.volumeGibSeconds += row.volumeGibSeconds
  into.relayedBytes += row.relayedBytes
}

export class PgComputerUsageRepo implements ComputerUsageRepo {
  constructor(private readonly db: PrismaLike) {}

  async accrue(a: ComputerAccrual): Promise<boolean> {
    const from = (a.meteredAt ?? a.since).getTime()
    // Whole seconds only, so the remainder is metered next time instead of lost.
    const seconds = Math.max(0, Math.floor((a.to.getTime() - from) / 1000))
    if (seconds === 0) return false
    const to = new Date(from + seconds * 1000)
    return withAmbientTx(this.db, async (tx) => {
      // The compare-and-set: two replicas sweeping at once bill the interval once.
      const moved = await tx.computer.updateMany({
        where: { id: a.computerId, poolMeteredAt: a.meteredAt },
        data: { poolMeteredAt: to }
      })
      if (moved.count === 0) return false
      if (!a.state) return true
      for (const { day, seconds: s } of splitByUtcDay(from, to.getTime())) {
        const running = a.state === 'running' ? s : 0
        const sleeping = a.state === 'sleeping' ? s : 0
        const volume = BigInt(Math.round(s * a.volumeGib))
        await tx.computerUsage.upsert({
          where: { orgId_day_computerId: { orgId: a.orgId, day, computerId: a.computerId } },
          create: {
            orgId: a.orgId,
            day,
            computerId: a.computerId,
            kind: 'managed',
            allocation: a.allocation,
            runningSeconds: running,
            sleepingSeconds: sleeping,
            volumeGibSeconds: volume
          },
          update: {
            runningSeconds: { increment: running },
            sleepingSeconds: { increment: sleeping },
            volumeGibSeconds: { increment: volume },
            ...(a.allocation ? { allocation: a.allocation } : {})
          }
        })
      }
      return true
    })
  }

  async addRelayed(entries: ReadonlyArray<{ computerId: string; bytes: number }>, at: Date): Promise<number> {
    const byId = new Map<string, number>()
    for (const e of entries) byId.set(e.computerId, (byId.get(e.computerId) ?? 0) + e.bytes)
    if (byId.size === 0) return 0
    const computers = await this.db.computer.findMany({
      where: { id: { in: [...byId.keys()] } },
      select: { id: true, orgId: true, kind: true, allocation: true }
    })
    const day = utcDay(at.getTime())
    for (const c of computers) {
      const bytes = BigInt(byId.get(c.id)!)
      const kind = c.kind === 'self_hosted' ? 'self-hosted' : c.kind
      const allocation = c.allocation === 'per_agent' ? 'per-agent' : c.allocation
      await this.db.computerUsage.upsert({
        where: { orgId_day_computerId: { orgId: c.orgId, day, computerId: c.id } },
        create: { orgId: c.orgId, day, computerId: c.id, kind, allocation, relayedBytes: bytes },
        update: { relayedBytes: { increment: bytes } }
      })
    }
    return computers.length
  }

  async desktopPhases(orgId: string): Promise<Array<{ allocation: string; phase: string; count: number }>> {
    const rows = await this.db.computer.groupBy({
      by: ['allocation', 'poolPhase'],
      where: { orgId, kind: 'managed', poolPhase: { not: null }, NOT: { poolPhase: 'reclaiming' } },
      _count: { _all: true }
    })
    return rows
      .filter((r) => r.allocation && r.poolPhase)
      .map((r) => ({
        allocation: r.allocation === 'per_agent' ? 'per-agent' : r.allocation!,
        phase: r.poolPhase!,
        count: r._count._all
      }))
  }

  async since(orgId: string, from: Date): Promise<{ runningSeconds: number; relayedBytes: number }> {
    const agg = await this.db.computerUsage.aggregate({
      where: { orgId, day: { gte: utcDay(from.getTime()) } },
      _sum: { runningSeconds: true, relayedBytes: true }
    })
    return { runningSeconds: agg._sum.runningSeconds ?? 0, relayedBytes: Number(agg._sum.relayedBytes ?? 0n) }
  }

  async usage(orgId: string, window: { from: Date; to: Date }): Promise<ComputerUsageTotals> {
    const rows = await this.db.computerUsage.findMany({
      where: { orgId, day: { gte: utcDay(window.from.getTime()), lt: window.to } },
      orderBy: [{ day: 'asc' }, { computerId: 'asc' }]
    })
    const totals = zero()
    const allocations = new Map<string, ComputerUsageRow>()
    const days = new Map<string, ComputerUsageRow>()
    const computers = new Map<string, ComputerUsageRow & { kind: string; allocation: string | null }>()
    for (const r of rows) {
      const row: ComputerUsageRow = {
        runningSeconds: r.runningSeconds,
        sleepingSeconds: r.sleepingSeconds,
        volumeGibSeconds: Number(r.volumeGibSeconds),
        relayedBytes: Number(r.relayedBytes)
      }
      add(totals, row)
      const allocation = r.allocation ?? r.kind
      add(allocations.get(allocation) ?? allocations.set(allocation, zero()).get(allocation)!, row)
      const day = isoDay(r.day)
      add(days.get(day) ?? days.set(day, zero()).get(day)!, row)
      const c =
        computers.get(r.computerId) ??
        computers.set(r.computerId, { ...zero(), kind: r.kind, allocation: r.allocation }).get(r.computerId)!
      add(c, row)
    }
    return {
      totals,
      allocations: [...allocations].map(([allocation, row]) => ({ allocation, ...row })),
      days: [...days].map(([day, row]) => ({ day, ...row })),
      computers: [...computers].map(([computerId, row]) => ({ computerId, ...row }))
    }
  }

  async touchViewer(orgId: string, computerId: string, userId: string, expiresAt: Date): Promise<void> {
    await this.db.computerViewerSession.upsert({
      where: { computerId_userId: { computerId, userId } },
      create: { computerId, userId, orgId, expiresAt },
      update: { orgId, expiresAt }
    })
  }

  async viewers(
    orgId: string,
    computerId: string,
    userId: string,
    now: Date
  ): Promise<{ org: number; computer: number }> {
    const live = { orgId, expiresAt: { gt: now }, NOT: { computerId, userId } }
    const [org, computer] = await Promise.all([
      this.db.computerViewerSession.count({ where: live }),
      this.db.computerViewerSession.count({ where: { ...live, computerId } })
    ])
    return { org, computer }
  }

  async reapViewers(before: Date): Promise<number> {
    const { count } = await this.db.computerViewerSession.deleteMany({ where: { expiresAt: { lt: before } } })
    return count
  }

  async settings(orgId: string): Promise<ComputerOrgSettingsRecord | null> {
    return await this.db.computerOrgSettings.findUnique({ where: { orgId } })
  }

  async setQuotas(orgId: string, quotas: unknown): Promise<ComputerOrgSettingsRecord> {
    return await this.db.computerOrgSettings.upsert({
      where: { orgId },
      create: { orgId, quotas: json(quotas) },
      update: { quotas: json(quotas) }
    })
  }

  async setEgress(orgId: string, egress: unknown, sealedPassword: string | null): Promise<ComputerOrgSettingsRecord> {
    return await this.db.computerOrgSettings.upsert({
      where: { orgId },
      create: { orgId, egress: json(egress), egressProxyPassword: sealedPassword },
      update: { egress: json(egress), egressProxyPassword: sealedPassword }
    })
  }
}
