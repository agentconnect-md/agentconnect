/**
 * Member sets — the named sets of daemons within which an agent's duty may be claimed
 * (docs/designs/daemon-groups.md §2). The install-wide pool is the ONE org-less row; org sets
 * arrive with the console CRUD in PR 2.
 *
 * Everything tenancy-shaped lives on the WRITE side here. `enrollDaemonInSet` is the only writer
 * of `member_set_member`, and it is where "an org-less set accepts only org-less daemons, an org
 * set only that org's daemons" is enforced — which is precisely what lets the ledger's read path
 * be one membership lookup with no tenancy branch.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DaemonId } from '../../domain/ids.js'
import type { MemberSetRecord, MemberSetRepo } from '../ports.js'
import { AgentSetPlacementDenied, MemberSetTenancyMismatch } from '../errors.js'

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
}
