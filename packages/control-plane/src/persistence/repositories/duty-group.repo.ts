// PgDutyGroupRepo — the CP-hosted duty ledger for k8s daemons.
// One `duty_group` row per connected component; `(holder, term, expiresAt)` is
// the lease. Every grant path bumps `term` (the fencing token); renewal never
// does. Vacancy is temporal: `holder IS NULL` or a lapsed `expiresAt`.
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DutyMemberKey, DutyReconcilePlan, DutyEdge, CronSeed } from '../../domain/duty.js'
import type { AgentHomeClaim, DutyGrantRecord, DutyGroupRecord, DutyGroupRepo, DutyReconcilePlanner } from '../ports.js'
import type { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { withTx } from '../prisma.js'

// Serializes the writers that CREATE or REWRITE rows for an org (applyReconcile
// and claimAgentHome) — row locks cannot fence rows that do not exist yet.
async function lockOrgDutyScope(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = JSON.stringify(['duty-group-recompute', orgId])
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

type Row = { id: string; orgId: string; holder: string | null; term: bigint; expiresAt: Date | null }

// Row-locked snapshot: FOR UPDATE fences the lease writers the advisory scope
// does not cover (claimVacant/renewHeld/release), so a plan can never be applied
// over rows a concurrent grant has moved; SKIP LOCKED claimants simply pass by.
async function lockOrgDutyRows(tx: Prisma.TransactionClient, orgId: string): Promise<Row[]> {
  return tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT id, "orgId", "holder", "term", "expiresAt" FROM "duty_group"
    WHERE "orgId" = ${orgId} ORDER BY id FOR UPDATE
  `)
}

async function lockDutyRow(tx: Prisma.TransactionClient, groupId: string): Promise<Row | null> {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT id, "orgId", "holder", "term", "expiresAt" FROM "duty_group"
    WHERE id = ${groupId}::uuid FOR UPDATE
  `)
  return rows[0] ?? null
}

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

  async vacateNonIncumbent(orgId: OrgId): Promise<string[]> {
    // Soak-phase placement fence: a holder keeps a group while it still hosts
    // AT LEAST ONE of its agents — so a split group cannot flap between two
    // partial incumbents — but a full move-away vacates the lease, letting the
    // new incumbent claim on its next beat (the old holder learns via digest
    // diff as a superseded revocation).
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "duty_group" g SET "holder" = NULL, "expiresAt" = NULL
      WHERE g."orgId" = ${orgId} AND g."holder" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "duty_group_member" m WHERE m."groupId" = g.id AND m."kind" = 'agent'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "duty_group_member" m
          JOIN "agent" a ON a.id = m."refId"
          WHERE m."groupId" = g.id AND m."kind" = 'agent' AND a."daemonId" = g."holder"
        )
      RETURNING g.id
    `)
    return rows.map((r) => r.id).sort()
  }

  async computeInputs(orgId: OrgId): Promise<{ edges: DutyEdge[]; seeds: CronSeed[] }> {
    const [integrations, crons] = await Promise.all([
      this.prisma.integration.findMany({
        where: { orgId, status: 'active', bot: { transport: 'socket', revokedAt: null } },
        select: { agentId: true, botId: true }
      }),
      this.prisma.cronDef.findMany({
        where: { orgId, enabled: true, agentId: { not: null } },
        select: { agentId: true }
      })
    ])
    return {
      edges: integrations.map((i) => ({ agentId: i.agentId, botId: i.botId })),
      seeds: crons.flatMap((c) => (c.agentId ? [{ agentId: c.agentId }] : []))
    }
  }

  async listDutyOrgs(afterOrgId: string | null, limit: number): Promise<string[]> {
    const after = afterOrgId ?? ''
    const rows = await this.prisma.$queryRaw<{ orgId: string }[]>(Prisma.sql`
      SELECT DISTINCT "orgId" FROM (
        SELECT "orgId" FROM "integration"
        UNION SELECT "orgId" FROM "cron_def" WHERE "enabled"
        UNION SELECT "orgId" FROM "duty_group"
      ) orgs
      WHERE "orgId" > ${after}
      ORDER BY "orgId" ASC
      LIMIT ${limit}
    `)
    return rows.map((r) => r.orgId)
  }

  async getByIds(groupIds: string[]): Promise<DutyGroupRecord[]> {
    if (groupIds.length === 0) return []
    const rows = await this.prisma.dutyGroup.findMany({ where: { id: { in: groupIds } }, orderBy: { id: 'asc' } })
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
      const rows = await lockOrgDutyRows(tx, orgId)
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

  async claimVacant(
    holder: DaemonId,
    max: number,
    now: Date,
    leaseMs: number,
    opts: { maxMembers?: number; incumbentOnly?: boolean } = {}
  ): Promise<DutyGrantRecord[]> {
    if (max <= 0) return []
    const expiresAt = new Date(now.getTime() + leaseMs)
    // Undeliverable groups are excluded AT THE CLAIM BOUNDARY: an oversized
    // vacancy sitting early in scan order must not be claimed-and-released on
    // every beat, starving the valid vacancies behind it.
    const sizeGate =
      opts.maxMembers === undefined
        ? Prisma.empty
        : Prisma.sql`AND (SELECT count(*) FROM "duty_group_member" m WHERE m."groupId" = "duty_group".id) <= ${opts.maxMembers}`
    // Soak-phase policy: only groups whose agents already live on the claimant.
    const incumbentGate = !opts.incumbentOnly
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (
          SELECT 1 FROM "duty_group_member" m
          JOIN "agent" a ON a.id = m."refId"
          WHERE m."groupId" = "duty_group".id AND m."kind" = 'agent' AND a."daemonId" = ${holder}::uuid
        )`
    // One transaction, so the grant's row locks hold until the returned
    // (term, members) snapshot is assembled — a reconcile cannot interleave and
    // pair the old term with rewritten membership. First valid claim wins;
    // SKIP LOCKED keeps racing claimants from queueing on each other's rows —
    // they simply take disjoint vacancies.
    return withTx(this.prisma, async (tx) => {
      const granted = await tx.$queryRaw<Row[]>(Prisma.sql`
        WITH picked AS (
          SELECT id FROM "duty_group"
          WHERE ("holder" IS NULL OR "expiresAt" IS NULL OR "expiresAt" < ${now}) ${sizeGate} ${incumbentGate}
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
        tx,
        granted.map((r) => r.id)
      )
      return granted.map((r) => ({
        groupId: r.id,
        orgId: r.orgId as OrgId,
        term: r.term,
        members: members.get(r.id) ?? []
      }))
    })
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

  async holdsAgent(holder: DaemonId, agentId: AgentId, now: Date): Promise<boolean> {
    // Unexpired-lease join only: a lapsed or reassigned group is not a holding,
    // so a stale member cannot keep pulling definitions it no longer serves.
    const rows = await this.prisma.$queryRaw<{ one: number }[]>(Prisma.sql`
      SELECT 1 AS one FROM "duty_group_member" m
      JOIN "duty_group" g ON g.id = m."groupId"
      WHERE m."kind" = 'agent' AND m."refId" = ${agentId}
        AND g."holder" = ${holder}::uuid AND g."expiresAt" IS NOT NULL AND g."expiresAt" > ${now}
      LIMIT 1
    `)
    return rows.length > 0
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
      // Org scope fences row creation against applyReconcile; the FOR UPDATE row
      // lock below fences the lease against claimVacant/renewHeld/release.
      await lockOrgDutyScope(tx, orgId)
      const member = await tx.dutyGroupMember.findUnique({ where: { kind_refId: { kind: 'agent', refId: agentId } } })
      if (!member) {
        // Claiming creates the lease: the first trigger for a botless agent.
        const groupId = this.mintId()
        await tx.dutyGroup.create({ data: { id: groupId, orgId, holder, term: 1n, expiresAt } })
        await tx.dutyGroupMember.create({ data: { kind: 'agent', refId: agentId, groupId, orgId } })
        return { granted: true, groupId, term: 1n, holder }
      }
      const row = await lockDutyRow(tx, member.groupId)
      if (row === null) throw new Error(`duty group ${member.groupId} vanished under its member row`)
      const live = row.holder !== null && row.expiresAt !== null && row.expiresAt > now
      if (live && row.holder === holder) {
        // Idempotent re-claim: refresh the horizon, never churn the term. CAS on
        // (holder, term) besides the row lock, so a moved lease can never be
        // extended by a stale reader; a miss falls through to report the row as
        // it now stands.
        const refreshed = await tx.dutyGroup.updateMany({
          where: { id: row.id, holder, term: row.term },
          data: { expiresAt }
        })
        if (refreshed.count === 1) return { granted: true, groupId: row.id, term: row.term, holder }
      } else if (live) {
        return { granted: false, groupId: row.id, term: row.term, holder: row.holder as DaemonId }
      } else {
        // Vacancy re-asserted in the write despite the row lock — belt and braces.
        const won = await tx.dutyGroup.updateMany({
          where: {
            id: row.id,
            OR: [{ holder: null }, { expiresAt: null }, { expiresAt: { lt: now } }]
          },
          data: { holder, term: { increment: 1 }, expiresAt }
        })
        if (won.count === 1) {
          const granted = await tx.dutyGroup.findUniqueOrThrow({ where: { id: row.id } })
          return { granted: true, groupId: granted.id, term: granted.term, holder }
        }
      }
      const after = await tx.dutyGroup.findUniqueOrThrow({ where: { id: row.id } })
      const stillMine = after.holder === holder && after.expiresAt !== null && after.expiresAt > now
      return {
        granted: stillMine,
        groupId: after.id,
        term: after.term,
        holder: after.holder as DaemonId | null
      }
    })
  }
}
