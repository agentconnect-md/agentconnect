// PgDutyGroupRepo — the CP-hosted duty ledger for k8s daemons.
// One `duty_group` row per connected component; `(holder, term, expiresAt)` is
// the lease. Every grant path bumps `term` (the fencing token); renewal never
// does. Vacancy is temporal: `holder IS NULL` or a lapsed `expiresAt`.
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DutyMemberKey, DutyReconcilePlan } from '../../domain/duty.js'
import type { AgentHomeClaim, DutyGrantRecord, DutyGroupRecord, DutyGroupRepo, DutyReconcilePlanner } from '../ports.js'
import type { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { withTx } from '../prisma.js'

// One recompute at a time per org: plan-then-apply reads its own snapshot, so
// two concurrent recomputes of the same org must serialize, CP-instance-wide.
async function lockOrgDutyScope(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = JSON.stringify(['duty-group-recompute', orgId])
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

// Serializes racing first-trigger claims for one agent; the write itself stays
// vacancy-conditional because claimVacant grants under row locks, not this one.
async function lockAgentHomeScope(tx: Prisma.TransactionClient, agentId: string): Promise<void> {
  const key = JSON.stringify(['duty-agent-home', agentId])
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

type Row = { id: string; orgId: string; holder: string | null; term: bigint; expiresAt: Date | null }

async function loadMembers(
  db: Prisma.TransactionClient | PrismaClient,
  groupIds: string[]
): Promise<Map<string, DutyMemberKey[]>> {
  if (groupIds.length === 0) return new Map()
  const rows = await db.dutyGroupMember.findMany({
    where: { groupId: { in: groupIds } },
    orderBy: [{ kind: 'asc' }, { refId: 'asc' }]
  })
  const byGroup = new Map<string, DutyMemberKey[]>()
  for (const m of rows) {
    const list = byGroup.get(m.groupId) ?? []
    list.push({ kind: m.kind, refId: m.refId })
    byGroup.set(m.groupId, list)
  }
  return byGroup
}

function toRecord(row: Row, members: DutyMemberKey[]): DutyGroupRecord {
  return {
    groupId: row.id,
    orgId: row.orgId as OrgId,
    holder: (row.holder as DaemonId | null) ?? null,
    term: row.term,
    expiresAt: row.expiresAt,
    members
  }
}

export class PgDutyGroupRepo implements DutyGroupRepo {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly mintId: () => string = () => crypto.randomUUID()
  ) {}

  async listForOrg(orgId: OrgId): Promise<DutyGroupRecord[]> {
    const rows = await this.prisma.dutyGroup.findMany({ where: { orgId }, orderBy: { id: 'asc' } })
    const members = await loadMembers(
      this.prisma,
      rows.map((r) => r.id)
    )
    return rows.map((r) => toRecord(r, members.get(r.id) ?? []))
  }

  async listHeldBy(holder: DaemonId): Promise<DutyGroupRecord[]> {
    const rows = await this.prisma.dutyGroup.findMany({ where: { holder }, orderBy: { id: 'asc' } })
    const members = await loadMembers(
      this.prisma,
      rows.map((r) => r.id)
    )
    return rows.map((r) => toRecord(r, members.get(r.id) ?? []))
  }

  async applyReconcile(
    orgId: OrgId,
    planner: DutyReconcilePlanner,
    opts: { now: Date; leaseMs: number }
  ): Promise<DutyReconcilePlan> {
    return withTx(this.prisma, async (tx) => {
      await lockOrgDutyScope(tx, orgId)
      const rows = await tx.dutyGroup.findMany({ where: { orgId }, orderBy: { id: 'asc' } })
      const members = await loadMembers(
        tx,
        rows.map((r) => r.id)
      )
      const plan = planner(rows.map((r) => toRecord(r, members.get(r.id) ?? [])))
      const expiresAt = new Date(opts.now.getTime() + opts.leaseMs)

      // Phase order matters: frees before inserts, so a member moving between
      // groups never trips the one-home-per-member primary key mid-plan.
      if (plan.deletes.length > 0) await tx.dutyGroup.deleteMany({ where: { orgId, id: { in: plan.deletes } } })
      const rewritten = plan.writes.map((w) => w.groupId)
      if (rewritten.length > 0) await tx.dutyGroupMember.deleteMany({ where: { groupId: { in: rewritten } } })
      const moved = [...plan.writes, ...plan.creates].flatMap((w) => w.members)
      if (moved.length > 0)
        await tx.dutyGroupMember.deleteMany({
          where: { OR: moved.map((m) => ({ kind: m.kind, refId: m.refId })) }
        })

      for (const w of plan.writes) {
        await tx.dutyGroupMember.createMany({
          data: w.members.map((m) => ({ kind: m.kind, refId: m.refId, groupId: w.groupId, orgId }))
        })
        if (w.regrantTo !== null)
          await tx.dutyGroup.update({
            where: { id: w.groupId },
            data: { holder: w.regrantTo, term: { increment: 1 }, expiresAt }
          })
      }
      for (const c of plan.creates) {
        const id = this.mintId()
        await tx.dutyGroup.create({
          data: {
            id,
            orgId,
            holder: c.grantTo,
            term: c.grantTo !== null ? 1n : 0n,
            expiresAt: c.grantTo !== null ? expiresAt : null
          }
        })
        await tx.dutyGroupMember.createMany({
          data: c.members.map((m) => ({ kind: m.kind, refId: m.refId, groupId: id, orgId }))
        })
      }
      return plan
    })
  }

  async claimVacant(holder: DaemonId, max: number, now: Date, leaseMs: number): Promise<DutyGrantRecord[]> {
    if (max <= 0) return []
    const expiresAt = new Date(now.getTime() + leaseMs)
    // First valid claim wins; SKIP LOCKED keeps racing claimants from queueing
    // on each other's rows — they simply take disjoint vacancies.
    const granted = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH picked AS (
        SELECT id FROM "duty_group"
        WHERE "holder" IS NULL OR "expiresAt" IS NULL OR "expiresAt" < ${now}
        ORDER BY "orgId", id
        LIMIT ${max}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "duty_group" g
      SET "holder" = ${holder}::uuid, "term" = g."term" + 1, "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
      FROM picked WHERE g.id = picked.id
      RETURNING g.id, g."orgId", g."holder", g."term", g."expiresAt"
    `)
    const members = await loadMembers(
      this.prisma,
      granted.map((r) => r.id)
    )
    return granted.map((r) => ({
      groupId: r.id,
      orgId: r.orgId as OrgId,
      term: r.term,
      members: members.get(r.id) ?? []
    }))
  }

  async renewHeld(holder: DaemonId, now: Date, leaseMs: number): Promise<string[]> {
    const expiresAt = new Date(now.getTime() + leaseMs)
    // Holder-conditional and term-preserving: a lapsed-but-unclaimed lease
    // renews (the CP "confirms the same terms"); a reassigned one matches zero
    // rows and the digest diff surfaces the supersession.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "duty_group" SET "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
      WHERE "holder" = ${holder}::uuid
      RETURNING id
    `)
    return rows.map((r) => r.id).sort()
  }

  async release(holder: DaemonId, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return
    // Vacate immediately but keep `term` — monotonicity is the whole token.
    await this.prisma.dutyGroup.updateMany({
      where: { holder, id: { in: groupIds } },
      data: { holder: null, expiresAt: null }
    })
  }

  async claimAgentHome(
    orgId: OrgId,
    agentId: AgentId,
    holder: DaemonId,
    now: Date,
    leaseMs: number
  ): Promise<AgentHomeClaim> {
    const expiresAt = new Date(now.getTime() + leaseMs)
    return withTx(this.prisma, async (tx) => {
      await lockAgentHomeScope(tx, agentId)
      const member = await tx.dutyGroupMember.findUnique({ where: { kind_refId: { kind: 'agent', refId: agentId } } })
      if (!member) {
        // Claiming creates the lease: the first trigger for a botless agent.
        const groupId = this.mintId()
        await tx.dutyGroup.create({ data: { id: groupId, orgId, holder, term: 1n, expiresAt } })
        await tx.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId } })
        return { granted: true, groupId, term: 1n, holder }
      }
      const row = await tx.dutyGroup.findUniqueOrThrow({ where: { id: member.groupId } })
      const live = row.holder !== null && row.expiresAt !== null && row.expiresAt > now
      if (live && row.holder === holder) {
        // Idempotent re-claim: refresh the horizon, never churn the term.
        await tx.dutyGroup.update({ where: { id: row.id }, data: { expiresAt } })
        return { granted: true, groupId: row.id, term: row.term, holder }
      }
      if (live) return { granted: false, groupId: row.id, term: row.term, holder: row.holder as DaemonId }
      // Vacancy-conditional even under the advisory lock: claimVacant grants
      // under row locks, not this scope, so re-assert vacancy in the write.
      const won = await tx.dutyGroup.updateMany({
        where: {
          id: row.id,
          OR: [{ holder: null }, { expiresAt: null }, { expiresAt: { lt: now } }]
        },
        data: { holder, term: { increment: 1 }, expiresAt }
      })
      const after = await tx.dutyGroup.findUniqueOrThrow({ where: { id: row.id } })
      return {
        granted: won.count === 1,
        groupId: after.id,
        term: after.term,
        holder: after.holder as DaemonId | null
      }
    })
  }
}
