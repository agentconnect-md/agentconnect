/**
 * Member sets — the named sets of daemons within which an agent's duty may be claimed
 * (docs/designs/daemon-groups.md §2). The install-wide pool is the ONE org-less row; an org's own
 * sets are rows with its `orgId`, created by an operator.
 *
 * Everything tenancy-shaped lives on the WRITE side here. `enrollDaemonInSet` is the only writer
 * of `member_set_member`, and it is where "an org-less set accepts only org-less daemons, an org
 * set only that org's daemons" is enforced — which is precisely what lets the ledger's read path
 * be one membership lookup with no tenancy branch.
 */
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DaemonId } from '../../domain/ids.js'
import type { MemberSetRecord, MemberSetRepo } from '../ports.js'
import { AgentSetPlacementDenied, DaemonPlacementInSet, MemberSetInUse, MemberSetTenancyMismatch } from '../errors.js'

/** The ONLY writer of `member_set_member`: the set's org and the daemon's org must be the same
 *  value, null (cross-org) included, or the row is refused. */
export async function enrollDaemonInSet(tx: Prisma.TransactionClient, setId: string, daemonId: string): Promise<void> {
  const [pair] = await tx.$queryRaw<{ setOrgId: string | null; daemonOrgId: string | null }[]>(Prisma.sql`
    SELECT s."orgId" AS "setOrgId", d."orgId" AS "daemonOrgId"
    FROM "member_set" s, "daemon" d
    WHERE s.id = ${setId}::uuid AND d.id = ${daemonId}::uuid
  `)
  if (!pair || pair.setOrgId !== pair.daemonOrgId) throw new MemberSetTenancyMismatch(setId, daemonId)
  // Idempotent: re-auth re-enrolls the same member. Moving a daemon BETWEEN sets is a two-phase
  // generation-fenced transition (§3), never this path, so a conflicting row is left alone.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "member_set_member" ("setId", "daemonId") VALUES (${setId}::uuid, ${daemonId}::uuid)
    ON CONFLICT ("daemonId") DO NOTHING
  `)
}

/**
 * The third write-time invariant, taken inside the transaction that writes the placement: a
 * `set`-placed agent may reference only the org-less set or a set of its own org. The read path
 * never re-checks it.
 */
export async function assertAgentMayUseSet(
  tx: Prisma.TransactionClient,
  agent: { id: string; orgId: string },
  setId: string
): Promise<void> {
  const [row] = await tx.$queryRaw<{ orgId: string | null }[]>(
    Prisma.sql`SELECT "orgId" FROM "member_set" WHERE id = ${setId}::uuid`
  )
  if (!row || (row.orgId !== null && row.orgId !== agent.orgId)) throw new AgentSetPlacementDenied(agent.id, setId)
}

/**
 * The converse of that invariant, and the reason it can be enforced statically (§3): a `daemon`
 * placement may not name a machine that is in a set. Such a machine serves only what it holds a
 * lease for, so an agent pinned to it would be placed and unservable at once.
 */
export async function assertDaemonNotInSet(
  tx: Prisma.TransactionClient,
  agentId: string,
  daemonId: string
): Promise<void> {
  const [row] = await tx.$queryRaw<{ one: number }[]>(
    Prisma.sql`SELECT 1 AS one FROM "member_set_member" WHERE "daemonId" = ${daemonId}::uuid`
  )
  if (row) throw new DaemonPlacementInSet(agentId, daemonId)
}

export class PgMemberSetRepo implements MemberSetRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async crossOrgSetId(): Promise<string | null> {
    const row = await this.prisma.memberSet.findFirst({ where: { orgId: null }, select: { id: true } })
    return row?.id ?? null
  }

  async get(setId: string): Promise<MemberSetRecord | null> {
    const row = await this.prisma.memberSet.findUnique({ where: { id: setId } })
    return row ? { id: row.id, orgId: row.orgId, name: row.name } : null
  }

  async setIdOf(daemonId: DaemonId): Promise<string | null> {
    const row = await this.prisma.memberSetMember.findUnique({ where: { daemonId }, select: { setId: true } })
    return row?.setId ?? null
  }

  async setOf(daemonId: DaemonId): Promise<MemberSetRecord | null> {
    const row = await this.prisma.memberSetMember.findUnique({ where: { daemonId }, select: { set: true } })
    return row ? { id: row.set.id, orgId: row.set.orgId, name: row.set.name } : null
  }

  async memberIdsOf(setId: string): Promise<string[]> {
    const rows = await this.prisma.memberSetMember.findMany({ where: { setId }, select: { daemonId: true } })
    return rows.map((r) => r.daemonId).sort()
  }

  async sharedStoreMemberIdsOf(setId: string): Promise<string[]> {
    // `set: { orgId: null }` IS the shared-store predicate — the install-wide pool is the one set
    // whose members are cluster daemons on the single data-plane store. An operator-built org set
    // may be self-hosted machines with private stores, so none of its members answers for another.
    const rows = await this.prisma.memberSetMember.findMany({
      where: { setId, set: { orgId: null } },
      select: { daemonId: true }
    })
    return rows.map((r) => r.daemonId).sort()
  }

  async enroll(setId: string, daemonId: DaemonId): Promise<void> {
    await this.prisma.$transaction((tx) => enrollDaemonInSet(tx, setId, daemonId))
  }

  async listForOrg(orgId: string): Promise<MemberSetRecord[]> {
    const rows = await this.prisma.memberSet.findMany({ where: { orgId }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, orgId: r.orgId, name: r.name }))
  }

  async agentCountsOf(setIds: readonly string[]): Promise<Map<string, number>> {
    if (setIds.length === 0) return new Map()
    const rows = await this.prisma.agent.groupBy({
      by: ['setId'],
      where: { setId: { in: [...setIds] } },
      _count: { _all: true }
    })
    return new Map(rows.flatMap((r) => (r.setId ? [[r.setId, r._count._all] as const] : [])))
  }

  async createForOrg(orgId: string, name: string): Promise<MemberSetRecord> {
    const row = await this.prisma.memberSet.create({ data: { id: randomUUID(), orgId, name } })
    return { id: row.id, orgId: row.orgId, name: row.name }
  }

  async renameForOrg(orgId: string, setId: string, name: string): Promise<MemberSetRecord | null> {
    const { count } = await this.prisma.memberSet.updateMany({ where: { id: setId, orgId }, data: { name } })
    return count === 0 ? null : { id: setId, orgId, name }
  }

  async deleteForOrg(orgId: string, setId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.memberSet.findFirst({ where: { id: setId, orgId }, select: { id: true } })
      if (!row) return false
      // Both cascades are silent — `member_set_member` is Cascade and `Agent.setId` is SetNull —
      // so a set with either still pointing at it is refused rather than emptied on the way out.
      const [members, agents] = await Promise.all([
        tx.memberSetMember.count({ where: { setId } }),
        tx.agent.count({ where: { setId } })
      ])
      if (members > 0 || agents > 0) throw new MemberSetInUse(setId)
      await tx.memberSet.delete({ where: { id: setId } })
      return true
    })
  }

  async withdraw(daemonId: DaemonId): Promise<void> {
    await this.prisma.memberSetMember.deleteMany({ where: { daemonId } })
  }
}
