/**
 * Member sets — the named sets of daemons within which an agent's duty may be claimed
 * (docs/designs/daemon-groups.md §2). The install-wide pool is the ONE org-less row; an org's own
 * sets are rows with its `orgId`, created by an operator.
 *
 * Everything tenancy-shaped lives on the WRITE side here. `enrollDaemonInSet` is the only writer
 * of `member_set_member`, and it is where "an org-less set accepts only org-less daemons, an org
 * set only that org's daemons" is enforced — which is precisely what lets the ledger's read path
 * be one membership lookup with no tenancy branch.
 *
 * ## The two fences
 *
 * Every invariant here is a check paired with a write, and both halves have concurrent writers, so
 * each pair needs something to serialize on:
 *
 * - **Per daemon** — {@link lockDaemonMembership}, an advisory transaction lock every writer of
 *   "is this daemon in a set" and every reader that acts on the answer takes: enrolment,
 *   withdrawal, the pool-placement guard, and the ledger's two claim paths. Without it, a
 *   placement that read "not a pool Pod" and a pool enrolment both commit and leave an agent
 *   pinned to a Pod the reconciler may retire; or a claim commits a live lease onto a member the
 *   withdrawal has just decided was idle.
 * - **Per set** — the `member_set` row itself, read `FOR SHARE` by everything that adds a
 *   reference to it and `FOR UPDATE` by the delete. Counting references without that lets a
 *   placement land after the count and be silently `SET NULL`ed by the cascade.
 *
 * Both are ordinary Postgres, taken inside the transaction that writes, so they hold across
 * control-plane instances rather than only within one process.
 */
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DaemonId } from '../../domain/ids.js'
import type { MemberSetRecord, MemberSetRepo } from '../ports.js'
import {
  AgentSetPlacementDenied,
  DaemonPlacementInSet,
  MemberSetInUse,
  MemberSetTenancyMismatch,
  DaemonHoldsDuty,
  DaemonAlreadyInSet
} from '../errors.js'

/**
 * The per-daemon membership fence. Held for the rest of the transaction, so a check and the write
 * it justifies are one step to every other writer. Keyed on the daemon alone: two daemons never
 * contend, and the ledger's claim paths are already serialized per member.
 */
export async function lockDaemonMembership(tx: Prisma.TransactionClient, daemonId: string): Promise<void> {
  const key = JSON.stringify(['member-set-membership', daemonId])
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

/** The per-set reference fence, reader side: the set may not be deleted while this transaction
 *  adds something that points at it. Null ⇒ no such set. */
async function shareSetRow(tx: Prisma.TransactionClient, setId: string): Promise<{ orgId: string | null } | null> {
  const [row] = await tx.$queryRaw<{ orgId: string | null }[]>(
    Prisma.sql`SELECT "orgId" FROM "member_set" WHERE id = ${setId}::uuid FOR SHARE`
  )
  return row ?? null
}

/** The ONLY writer of `member_set_member`: the set's org and the daemon's org must be the same
 *  value, null (cross-org) included, or the row is refused. Takes both fences — the daemon's,
 *  so a concurrent placement cannot pin an agent to the machine it is enrolling, and the set's,
 *  so a concurrent delete cannot drop the set this row points at. */
export async function enrollDaemonInSet(tx: Prisma.TransactionClient, setId: string, daemonId: string): Promise<void> {
  await lockDaemonMembership(tx, daemonId)
  const set = await shareSetRow(tx, setId)
  const [daemon] = await tx.$queryRaw<{ orgId: string | null }[]>(
    Prisma.sql`SELECT "orgId" FROM "daemon" WHERE id = ${daemonId}::uuid`
  )
  if (!set || !daemon || set.orgId !== daemon.orgId) throw new MemberSetTenancyMismatch(setId, daemonId)
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
 * never re-checks it. `FOR SHARE` so the set cannot be deleted out from under the placement.
 */
export async function assertAgentMayUseSet(
  tx: Prisma.TransactionClient,
  agent: { id: string; orgId: string },
  setId: string
): Promise<void> {
  const row = await shareSetRow(tx, setId)
  if (!row || (row.orgId !== null && row.orgId !== agent.orgId)) throw new AgentSetPlacementDenied(agent.id, setId)
}

/**
 * A `daemon` placement may not name a POOL member (§3). Under the daemon fence, so it cannot race
 * the enrolment that is putting the machine there.
 */
export async function assertDaemonNotInSet(
  tx: Prisma.TransactionClient,
  agentId: string,
  daemonId: string
): Promise<void> {
  await lockDaemonMembership(tx, daemonId)
  // Only the install-wide pool refuses a pin, and not because membership conflicts with one — a
  // `daemon` placement is eligible for exactly that machine either way. It is that a pool member
  // is a REPLACEABLE identity: the reconciler retires Pods without notice, so a pin to one is a
  // pointer that outlives what it names. An org's own machines are stable, so pinning an agent to
  // one is allowed whether or not it has joined a group.
  const [row] = await tx.$queryRaw<{ one: number }[]>(Prisma.sql`
    SELECT 1 AS one FROM "member_set_member" m
    JOIN "member_set" s ON s.id = m."setId"
    WHERE m."daemonId" = ${daemonId}::uuid AND s."orgId" IS NULL
  `)
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

  /**
   * Join, keeping whatever is pinned to the machine (daemon-groups.md §3).
   *
   * Pinning and membership are not in conflict, and the ledger is where that is decided: a
   * `daemon` placement is eligible for exactly that machine — `agent."daemonId" = holder`, with no
   * membership term in the predicate — so the machine remains the ONLY daemon that may hold those
   * agents, member or not. It enforces duties now, so it serves them through a lease instead of
   * outright; that lease is one nothing else can take. Nothing moves and nothing is stopped.
   */
  async enrollOperator(setId: string, daemonId: DaemonId): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockDaemonMembership(tx, daemonId)
      // Re-read membership UNDER the lock. The insert is idempotent, so the losing half of two
      // concurrent enrolments into different sets would otherwise no-op and still answer success,
      // naming a set the daemon never joined. Re-entering the set it is already in stays a no-op.
      const [current] = await tx.$queryRaw<{ setId: string }[]>(
        Prisma.sql`SELECT "setId" FROM "member_set_member" WHERE "daemonId" = ${daemonId}::uuid`
      )
      if (current) {
        if (current.setId !== setId) throw new DaemonAlreadyInSet(daemonId, current.setId)
        return
      }
      await enrollDaemonInSet(tx, setId, daemonId)
    })
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
      // `FOR UPDATE` on the set row is the reference fence's writer side: every path that adds a
      // reference reads the same row `FOR SHARE` first, so nothing can commit a member or a
      // placement between the counts below and the delete.
      const [row] = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "member_set" WHERE id = ${setId}::uuid AND "orgId" = ${orgId} FOR UPDATE`
      )
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

  async withdraw(daemonId: DaemonId, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Stop-and-confirm, as one step (§3). Under the daemon fence the ledger's claim paths cannot
      // hand this member a lease between the check and the delete, so "it holds nothing live" is
      // still true at the moment it stops being a member — which is what keeps a successor from
      // taking work the leaver may still be running.
      await lockDaemonMembership(tx, daemonId)
      const [held] = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM "duty_group"
        WHERE "holder" = ${daemonId}::uuid AND "expiresAt" IS NOT NULL AND "expiresAt" > ${now}
      `)
      const live = Number(held?.n ?? 0n)
      if (live > 0) throw new DaemonHoldsDuty(daemonId, live)
      await tx.memberSetMember.deleteMany({ where: { daemonId } })
      // Vacate what it still nominally holds, as §3's commit step says. Every one of these is
      // already lapsed — the check above just proved it — so this takes nothing from anyone; what
      // it removes is the ex-member's ability to REVIVE them, since renewal is holder-conditional
      // and carries no expiry predicate. `term` is untouched: monotonicity is the whole token.
      await tx.dutyGroup.updateMany({
        where: { holder: daemonId },
        data: { holder: null, expiresAt: null, confirmedTerm: null, confirmedHolder: null }
      })
    })
  }
}
