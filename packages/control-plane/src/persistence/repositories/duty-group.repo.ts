// PgDutyGroupRepo — the CP-hosted duty ledger for k8s daemons.
// One `duty_group` row per connected component; `(holder, term, expiresAt)` is
// the lease. Every grant path bumps `term` (the fencing token); renewal never
// does. Vacancy is temporal: `holder IS NULL` or a lapsed `expiresAt`.
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { DutyMemberKey, DutyReconcilePlan, DutyEdge, AgentSeed } from '../../domain/duty.js'
import type {
  AgentHomeClaim,
  CapabilityBlockedVacancy,
  DutyDigestEntry,
  DutyGrantRecord,
  DutyGroupRecord,
  DutyGroupRepo,
  DutyReconcilePlanner,
  PoolTelemetryRow
} from '../ports.js'
import type { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { withTx } from '../prisma.js'
import { lockDaemonMembership } from './member-set.repo.js'

// Serializes the writers that CREATE or REWRITE rows for an org (applyReconcile
// and claimAgentHome) — row locks cannot fence rows that do not exist yet.
async function lockOrgDutyScope(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  const key = JSON.stringify(['duty-group-recompute', orgId])
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

type Row = { id: string; orgId: string; holder: string | null; term: bigint; expiresAt: Date | null }

/**
 * The eligibility predicate, once, as SQL — the row-wise mirror of `domain/placement.ts#mayHold`.
 * May `holder` hold the duty of the agent row `agent`? A `set` placement is claimable by the
 * members of that set, which is ONE join to `member_set_member` on `(agent.setId, holder)`; a
 * `daemon` placement is that one machine; an unplaced agent has no eligible holder.
 *
 * Tenancy is not a branch here. The write-time invariants (daemon-groups.md §2) guarantee what
 * membership MEANS — an org-less set holds only org-less daemons, an org set only that org's — so
 * "the holder is in the agent's set" already implies the tenancy narrowing. The claimant's scope
 * is therefore read from the ledger's own tables, never asserted by the caller.
 *
 * Both claim paths and the placement fence share it, so a lease can never be taken under one rule
 * and kept under another.
 */
function eligibleAgent(agent: Prisma.Sql, holder: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    CASE ${agent}."placementKind"
      WHEN 'set' THEN EXISTS (
        SELECT 1 FROM "member_set_member" ms
        WHERE ms."setId" = ${agent}."setId" AND ms."daemonId" = ${holder}
      )
      ELSE ${agent}."daemonId" IS NOT NULL AND ${agent}."daemonId" = ${holder}
    END
  )`
}

/**
 * A group is claimable by `holder` only when EVERY agent in it is one the holder may hold. Stated
 * as "no ineligible agent" rather than "some eligible agent": a group that merges a set agent
 * with a machine-placed one must be claimable by neither, or the winner serves an agent the other
 * side is already serving — the duplicate service the ledger exists to prevent.
 *
 * A member ref whose agent row is gone cannot be adjudicated and does not block: the group is
 * reaped by the next recompute, and install-on-grant refuses an empty bundle in the meantime.
 */
function noIneligibleAgent(group: Prisma.Sql, holder: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "duty_group_member" m
    JOIN "agent" a ON a.id = m."refId"
    WHERE m."groupId" = ${group} AND m."kind" = 'agent'
      AND NOT ${eligibleAgent(Prisma.sql`a`, holder)}
  )`
}

/** One member's advertised `capabilities.platforms`, as jsonb. NULL for a row that never
 *  registered, or one whose capabilities carry no list — every caller reads that as fail-closed. */
function advertisedPlatforms(holder: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT d."capabilities"->'platforms' FROM "daemon" d WHERE d.id = ${holder})`
}

/**
 * The CAPABILITY gate — the row-wise mirror of `domain/platform-capability.ts#servesPlatforms`,
 * and the claim-time half of the install-time gate in `http/daemon-platform-capability.ts`.
 *
 * May `holder` serve every platform this agent's active integrations name? A daemon reads an
 * integration's config through its own platform-module registry and fails CLOSED on an id it has
 * no module for — it skips the integration silently — so a member of an older image that claims an
 * agent using a newly added platform takes that agent's whole surface there dark until the group
 * moves again. That window opens on EVERY platform's rollout, which is why this rides the claim
 * rather than the install alone.
 *
 * Fail-closed on the daemon read too: a missing row, or capabilities carrying no `platforms` list,
 * yields NULL, `COALESCE` reads it as "does not advertise", and the claim is refused. An agent
 * with no active integration requires nothing and is claimable by anyone, which is what keeps
 * botless agents (webchat, cron, A2A) out of the gate entirely.
 */
function servesAgentPlatforms(agentId: Prisma.Sql, holder: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "integration" i
    WHERE i."agentId" = ${agentId} AND i."status" = 'active'
      AND NOT COALESCE(${advertisedPlatforms(holder)} @> to_jsonb(i."platform"), false)
  )`
}

/** The group-wise reading of the capability gate, stated like {@link noIneligibleAgent}: a group is
 *  claimable only when EVERY agent in it is one the holder can serve. Deliberately NOT folded into
 *  the placement predicate — placement says who MAY hold, capability says who CAN serve, and only
 *  the second may be answered by a stale image. Keeping them apart is also what keeps
 *  `vacateIneligible` from tearing down live service over a capability read. */
function servesGroupPlatforms(group: Prisma.Sql, holder: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "duty_group_member" m
    WHERE m."groupId" = ${group} AND m."kind" = 'agent'
      AND NOT ${servesAgentPlatforms(Prisma.sql`m."refId"`, holder)}
  )`
}

/**
 * The rollout barrier (k8s-daemon-pool.md §12), as a predicate the CLAIM STATEMENT itself carries:
 * true unless a LIVE member of the claimant's set — one seen since `liveSince`, or the claimant
 * itself — carries a different, NEWER generation, generations ranking by their earliest live
 * member's `generationSince`. Folded into the claim's own WHERE so the read and the write are one
 * statement: a registration committing between a separate check and the write cannot let an older
 * member take a just-vacated group. A null-generation claimant, or one in no set, is never held back.
 */
function noNewerGenerationLive(holder: Prisma.Sql, liveSince: Date): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    WITH me AS (
      SELECT d."generation", m."setId"
      FROM "daemon" d JOIN "member_set_member" m ON m."daemonId" = d.id
      WHERE d.id = ${holder} AND d."generation" IS NOT NULL
    ),
    gens AS (
      SELECT d."generation", MIN(d."generationSince") AS since
      FROM "daemon" d JOIN "member_set_member" m ON m."daemonId" = d.id, me
      WHERE m."setId" = me."setId" AND d."generation" IS NOT NULL
        AND (d."lastSeenAt" >= ${liveSince} OR d.id = ${holder})
      GROUP BY d."generation"
    )
    SELECT 1 FROM gens other, gens mine, me
    WHERE mine."generation" = me."generation" AND other."generation" <> me."generation"
      AND other.since > mine.since
  )`
}

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

  async vacateIneligible(orgId: OrgId): Promise<string[]> {
    // The placement fence, stated as the eligibility predicate read from the holder's side: a
    // lease survives exactly as long as its holder may still hold every agent in the group. An
    // agent moved off the pool onto a machine, or off one machine onto another, therefore vacates
    // the lease on the next sweep and the eligible member claims it on its next beat (the old
    // holder learns through the digest diff, as a superseded revocation).
    //
    // The holder's own scope comes from its membership row, so this is the same rule
    // `claimVacant` applies, not a second one that can disagree.
    // A group whose agents are ALL unplaced has no eligible holder at all and is vacated too:
    // nothing may serve an unplaced agent, and leaving the lease standing would keep one member
    // serving what the operator detached.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "duty_group" g SET "holder" = NULL, "expiresAt" = NULL,
        "confirmedTerm" = NULL, "confirmedHolder" = NULL
      FROM "daemon" d
      WHERE g."orgId" = ${orgId} AND g."holder" IS NOT NULL AND d.id = g."holder"
        AND NOT ${noIneligibleAgent(Prisma.sql`g.id`, Prisma.sql`g."holder"`)}
      RETURNING g.id
    `)
    return rows.map((r) => r.id).sort()
  }

  // EVERY agent seeds a component. The ledger's whole job is to name one owner
  // per agent, and ownability is a property of the agent, not of its ingress —
  // an agent with no socket bot and no cron (webchat, A2A, relay-ingress only)
  // is exactly the case the edge-derived set used to miss, leaving the sweep to
  // delete the singleton the activation rendezvous had just minted. Crons need
  // no query of their own any more: a cron's agent is an agent.
  async computeInputs(orgId: OrgId): Promise<{ edges: DutyEdge[]; agents: AgentSeed[] }> {
    const [integrations, agents] = await Promise.all([
      this.prisma.integration.findMany({
        where: { orgId, status: 'active', bot: { transport: 'socket', revokedAt: null } },
        select: { agentId: true, botId: true }
      }),
      this.prisma.agent.findMany({ where: { orgId }, select: { id: true } })
    ])
    return {
      edges: integrations.map((i) => ({ agentId: i.agentId, botId: i.botId })),
      agents: agents.map((a) => ({ agentId: a.id }))
    }
  }

  // Any org with an agent has components to derive; `duty_group` keeps orgs
  // whose last agent is gone in the rotation until their rows are reaped.
  async listDutyOrgs(afterOrgId: string | null, limit: number): Promise<string[]> {
    const after = afterOrgId ?? ''
    const rows = await this.prisma.$queryRaw<{ orgId: string }[]>(Prisma.sql`
      SELECT DISTINCT "orgId" FROM (
        SELECT "orgId" FROM "agent"
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
            // A composition rewrite re-grants IN PLACE at a bumped term, and that bump IS the
            // invalidation: the member has admitted the old composition, not this one, so it must
            // re-report before ingress is addressed at it again. No separate clear — introducing a
            // second reason for the confirmation to move would be a second thing to keep in sync.
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
    opts: { maxMembers?: number; excludeGroupIds?: readonly string[] } = {}
  ): Promise<DutyGrantRecord[]> {
    if (max <= 0) return []
    const expiresAt = new Date(now.getTime() + leaseMs)
    // The rollout barrier, in the same statement as the claim (see `noNewerGenerationLive`). Live
    // means seen within the lease horizon — the ledger's one notion of liveness.
    const generationGate = Prisma.sql`AND ${noNewerGenerationLive(Prisma.sql`${holder}::uuid`, new Date(now.getTime() - leaseMs))}`
    // Undeliverable groups are excluded AT THE CLAIM BOUNDARY: an oversized
    // vacancy sitting early in scan order must not be claimed-and-released on
    // every beat, starving the valid vacancies behind it.
    const sizeGate =
      opts.maxMembers === undefined
        ? Prisma.empty
        : Prisma.sql`AND (SELECT count(*) FROM "duty_group_member" m WHERE m."groupId" = "duty_group".id) <= ${opts.maxMembers}`
    // The eligibility gate — the whole grant policy, and the only one. There is no incumbency test
    // left: what a member may claim follows from the agents' placement, not from where their state
    // happens to already be.
    const eligibilityGate = Prisma.sql`AND ${noIneligibleAgent(Prisma.sql`"duty_group".id`, Prisma.sql`${holder}::uuid`)}`
    // The capability gate: placement says this member MAY hold the group, this says it CAN serve
    // it. Fail-closed by design — a group needing a platform no live member advertises simply
    // stays vacant, and the pool gauges report it under its own series rather than as scale-up
    // demand nothing could satisfy.
    const capabilityGate = Prisma.sql`AND ${servesGroupPlatforms(Prisma.sql`"duty_group".id`, Prisma.sql`${holder}::uuid`)}`
    // The caller's refusal backoff: a group this member has just failed to install is skipped so
    // it can reach one that can serve it, instead of being re-taken on the very next beat.
    const backoffGate =
      opts.excludeGroupIds && opts.excludeGroupIds.length > 0
        ? Prisma.sql`AND "duty_group".id <> ALL(${opts.excludeGroupIds as string[]}::uuid[])`
        : Prisma.empty
    // One transaction, so the grant's row locks hold until the returned
    // (term, members) snapshot is assembled — a reconcile cannot interleave and
    // pair the old term with rewritten membership. First valid claim wins;
    // SKIP LOCKED keeps racing claimants from queueing on each other's rows —
    // they simply take disjoint vacancies.
    return withTx(this.prisma, async (tx) => {
      // The membership fence, before the claim reads eligibility from `member_set_member`: a
      // withdrawal holding it has already decided this member holds nothing live, and a grant
      // committing after that decision would hand work to a machine that is about to stop being
      // a member (daemon-groups.md §3).
      await lockDaemonMembership(tx, holder)
      const granted = await tx.$queryRaw<Row[]>(Prisma.sql`
        WITH picked AS (
          SELECT id FROM "duty_group"
          WHERE ("holder" IS NULL OR "expiresAt" IS NULL OR "expiresAt" < ${now}) ${sizeGate} ${eligibilityGate} ${capabilityGate} ${backoffGate} ${generationGate}
          ORDER BY "orgId", id
          LIMIT ${max}
          FOR UPDATE SKIP LOCKED
        )
        -- The confirmation columns are deliberately untouched: this bumps the term, and a
        -- confirmation only counts while it matches (holder, term), so the grant is unconfirmed by
        -- construction. That includes the SAME member re-taking its own lapsed lease — it may have
        -- fenced and dropped the group in between and be re-installing right now.
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

  async capabilityBlockedVacancies(
    holder: DaemonId,
    now: Date,
    opts: { maxMembers?: number; excludeGroupIds?: readonly string[]; limit?: number } = {}
  ): Promise<CapabilityBlockedVacancy[]> {
    // The claim's own gates, minus the capability one — which is negated instead, so this reports
    // exactly the groups the claim refused FOR CAPABILITY and nothing else. The generation barrier
    // is deliberately out: a held-back member still deserves to know what it could not have served.
    const sizeGate =
      opts.maxMembers === undefined
        ? Prisma.empty
        : Prisma.sql`AND (SELECT count(*) FROM "duty_group_member" m WHERE m."groupId" = g.id) <= ${opts.maxMembers}`
    const backoffGate =
      opts.excludeGroupIds && opts.excludeGroupIds.length > 0
        ? Prisma.sql`AND g.id <> ALL(${opts.excludeGroupIds as string[]}::uuid[])`
        : Prisma.empty
    const rows = await this.prisma.$queryRaw<{ groupId: string; agentId: string; platform: string }[]>(Prisma.sql`
      SELECT DISTINCT g.id AS "groupId", m."refId" AS "agentId", i."platform" AS platform
      FROM "duty_group" g
      JOIN "duty_group_member" m ON m."groupId" = g.id AND m."kind" = 'agent'
      JOIN "integration" i ON i."agentId" = m."refId" AND i."status" = 'active'
      WHERE (g."holder" IS NULL OR g."expiresAt" IS NULL OR g."expiresAt" < ${now})
        ${sizeGate} ${backoffGate}
        AND ${noIneligibleAgent(Prisma.sql`g.id`, Prisma.sql`${holder}::uuid`)}
        AND NOT COALESCE(${advertisedPlatforms(Prisma.sql`${holder}::uuid`)} @> to_jsonb(i."platform"), false)
      ORDER BY "groupId", "agentId", platform
      LIMIT ${opts.limit ?? 100}
    `)
    // Folded per (group, agent) so the caller logs one line naming every platform it is missing.
    const byAgent = new Map<string, CapabilityBlockedVacancy>()
    for (const row of rows) {
      const key = `${row.groupId}/${row.agentId}`
      const entry = byAgent.get(key) ?? { groupId: row.groupId, agentId: row.agentId as AgentId, missingPlatforms: [] }
      entry.missingPlatforms.push(row.platform)
      byAgent.set(key, entry)
    }
    return [...byAgent.values()]
  }

  async renewHeld(holder: DaemonId, now: Date, leaseMs: number): Promise<string[]> {
    const expiresAt = new Date(now.getTime() + leaseMs)
    return withTx(this.prisma, async (tx) => {
      // Renewal REVIVES a lapsed lease — it carries no expiry predicate, by design ("the CP
      // confirms the same terms"). So it is a lease-creating write as far as a withdrawal is
      // concerned, and it takes the same membership fence the claim paths do: without it a beat
      // landing just after a withdrawal read "nothing live" makes every lapsed group live again
      // under a daemon that is no longer a member (daemon-groups.md §3).
      await lockDaemonMembership(tx, holder)
      // Holder-conditional and term-preserving: a lapsed-but-unclaimed lease
      // renews; a reassigned one matches zero rows and the digest diff surfaces
      // the supersession.
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "duty_group" SET "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
        WHERE "holder" = ${holder}::uuid
        RETURNING id
      `)
      return rows.map((r) => r.id).sort()
    })
  }

  async release(holder: DaemonId, groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return
    // Vacate immediately but keep `term` — monotonicity is the whole token.
    await this.prisma.dutyGroup.updateMany({
      where: { holder, id: { in: groupIds } },
      data: { holder: null, expiresAt: null, confirmedTerm: null, confirmedHolder: null }
    })
  }

  async newerGenerationLive(holder: DaemonId, now: Date, liveMs: number): Promise<boolean> {
    // The pre-check and log source only: correctness lives in the claim statements, which carry
    // the same predicate (`noNewerGenerationLive`).
    const rows = await this.prisma.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT ${noNewerGenerationLive(Prisma.sql`${holder}::uuid`, new Date(now.getTime() - liveMs))} AS ok
    `)
    return rows[0]?.ok !== true
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

  async poolTelemetry(now: Date, liveMs: number, maxMembers: number): Promise<PoolTelemetryRow[]> {
    // Liveness is the ledger's one notion of it, as everywhere else: seen within the lease horizon.
    const liveSince = new Date(now.getTime() - liveMs)
    return this.prisma.$queryRaw<PoolTelemetryRow[]>(Prisma.sql`
      WITH live AS (
        SELECT d.id, msm."setId", d."maxAgents"
        FROM "daemon" d JOIN "member_set_member" msm ON msm."daemonId" = d.id
        WHERE d."lastSeenAt" >= ${liveSince}
      ),
      -- maxAgents <= 0 is the daemon's UNBOUNDED sentinel, not a ceiling of zero
      -- (Daemon.dutyHeadroomForPendingClaim returns +Infinity for it; the heartbeat's finite
      -- number is only a batching hint). Summing it raw would report a member that accepts
      -- everything as contributing nothing, so a pool with no ceiling would read as permanently
      -- full. Counted separately instead, and the capacity sum covers the bounded members only —
      -- which also keeps a negative value, allowed by the wire schema, out of the arithmetic.
      cap AS (
        SELECT "setId",
               count(*)::int AS members,
               count(*) FILTER (WHERE "maxAgents" <= 0)::int AS unbounded,
               COALESCE(sum("maxAgents") FILTER (WHERE "maxAgents" > 0), 0)::int AS capacity
        FROM live GROUP BY "setId"
      ),
      -- Used capacity read the way the member gates itself (§12): duty-covered agents, deduped,
      -- under UNEXPIRED leases only, so a lapsed lease frees its headroom here exactly when it
      -- frees it at the claim.
      used AS (
        SELECT l."setId", count(DISTINCT m."refId")::int AS agents
        FROM "duty_group" g
        JOIN live l ON l.id = g."holder"
        JOIN "duty_group_member" m ON m."groupId" = g.id AND m."kind" = 'agent'
        WHERE g."expiresAt" IS NOT NULL AND g."expiresAt" > ${now}
        GROUP BY l."setId"
      ),
      -- A vacancy counts against a set only when that set could actually take it, which is the
      -- claimVacant eligibility gate restated set-wise: every RESOLVABLE agent in the group is
      -- set-placed into one and the same set. Without this the count is dominated by the singleton
      -- rows of machine-placed agents, which are vacant by design and forever (§6).
      vacant AS (
        SELECT g.id,
               -- Single-valued by the HAVING below; uuid has no min(), so take it from the array.
               (array_agg(DISTINCT a."setId"))[1] AS "setId",
               GREATEST(EXTRACT(EPOCH FROM (${now}::timestamptz - COALESCE(g."expiresAt", g."updatedAt"))), 0) AS age,
               (SELECT count(*) FROM "duty_group_member" dm WHERE dm."groupId" = g.id) AS size
        FROM "duty_group" g
        JOIN "duty_group_member" m ON m."groupId" = g.id AND m."kind" = 'agent'
        JOIN "agent" a ON a.id = m."refId"
        WHERE g."holder" IS NULL OR g."expiresAt" IS NULL OR g."expiresAt" < ${now}
        GROUP BY g.id
        HAVING count(*) FILTER (WHERE a."placementKind" <> 'set' OR a."setId" IS NULL) = 0
           AND count(DISTINCT a."setId") = 1
      ),
      -- The capability gate, restated set-wise from the very predicate claimVacant carries: a
      -- vacancy is blocked when NO live member of its set advertises every platform the group's
      -- integrations name. Mid-rollout that is a real gap, and it is split out for the same reason
      -- oversized groups are — scaling the pool cannot clear it, so it must not pin the capacity
      -- alarm; rolling the image forward is the remediation, and the series says so.
      -- A set with NO live member at all is a liveness signal, not an image gap: the members gauge
      -- already reports it, and reading every vacancy as blocked there would mute the claimable
      -- demand a quiet or scaled-to-zero pool still has. Only members present can prove a gap.
      blocked AS (
        SELECT v.*,
               (EXISTS (SELECT 1 FROM live l WHERE l."setId" = v."setId")
                AND NOT EXISTS (
                  SELECT 1 FROM live l
                  WHERE l."setId" = v."setId" AND ${servesGroupPlatforms(Prisma.sql`v.id`, Prisma.sql`l.id`)}
                )) AS "capabilityBlocked"
        FROM vacant v
      ),
      -- Oversized groups are split out, never folded into the claimable count: they are
      -- undeliverable on this wire at any pool size (§5), so counting them as unmet demand would
      -- pin a capacity alert high forever. They are their own signal — D16, a dedicated daemon.
      vac AS (
        SELECT "setId",
               count(*) FILTER (WHERE size <= ${maxMembers} AND NOT "capabilityBlocked")::int AS groups,
               count(*) FILTER (WHERE size > ${maxMembers})::int AS oversized,
               count(*) FILTER (WHERE size <= ${maxMembers} AND "capabilityBlocked")::int AS "capabilityBlocked",
               COALESCE(
                 max(age) FILTER (WHERE size <= ${maxMembers} AND NOT "capabilityBlocked"), 0
               )::double precision AS oldest
        FROM blocked GROUP BY "setId"
      )
      SELECT s.id AS "setId", s.name AS "setName", (s."orgId" IS NULL) AS "installWide",
             COALESCE(cap.members, 0)::int AS "liveMembers",
             COALESCE(cap.unbounded, 0)::int AS "unboundedMembers",
             COALESCE(cap.capacity, 0)::int AS "capacityAgents",
             COALESCE(used.agents, 0)::int AS "dutyAgents",
             COALESCE(vac.groups, 0)::int AS "vacantGroups",
             COALESCE(vac.oversized, 0)::int AS "oversizedVacantGroups",
             COALESCE(vac."capabilityBlocked", 0)::int AS "capabilityBlockedVacantGroups",
             COALESCE(vac.oldest, 0)::double precision AS "oldestVacancySec"
      FROM "member_set" s
      LEFT JOIN cap ON cap."setId" = s.id
      LEFT JOIN used ON used."setId" = s.id
      LEFT JOIN vac ON vac."setId" = s.id
      ORDER BY s.id
    `)
  }

  async confirmHeld(holder: DaemonId, reported: readonly DutyDigestEntry[]): Promise<string[]> {
    if (reported.length === 0) return []
    // The digest confirms THIS grant, not the group in general: the reported term has to match the
    // row's current one. That is the same rule the lease exchange already applies to renewal —
    // confirm the terms or supersede, never both — so a member still reporting the previous term
    // (mid-admission of a re-grant, or a beat that crossed one) confirms nothing.
    //
    // Idempotent and first-write-wins: an already-matching row is excluded, so the returned set is
    // exactly the grants that became facts on THIS beat, which is what the routing convergence is
    // keyed on. Holder-conditional too, so a digest naming a group the ledger has since moved
    // confirms nothing either.
    const values = Prisma.join(
      reported.map((entry) => Prisma.sql`(${entry.groupId}::uuid, ${entry.term}::bigint)`),
      ','
    )
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "duty_group" g
      SET "confirmedTerm" = g."term", "confirmedHolder" = g."holder"
      FROM (VALUES ${values}) AS reported(id, term)
      WHERE g.id = reported.id AND g."term" = reported.term
        AND g."holder" = ${holder}::uuid
        AND (g."confirmedTerm" IS DISTINCT FROM g."term" OR g."confirmedHolder" IS DISTINCT FROM g."holder")
      RETURNING g.id
    `)
    return rows.map((r) => r.id).sort()
  }

  async confirmedHoldersOf(agentId: AgentId, now: Date): Promise<DaemonId[]> {
    // `holdersOf` with the confirmation term: the same live-lease join, restricted to holders whose
    // reported hold is the one the row currently describes. INGRESS addressing uses this — naming a
    // member that is still installing sends a routable message to a daemon that refuses it, and matching
    // on (holder, term) rather than on "a confirmation exists" is what stops a re-take, a
    // composition rewrite or a stale-term digest from inheriting one it never earned.
    const rows = await this.prisma.$queryRaw<{ holder: string }[]>(Prisma.sql`
      SELECT DISTINCT g."holder" AS holder FROM "duty_group_member" m
      JOIN "duty_group" g ON g.id = m."groupId"
      WHERE m."kind" = 'agent' AND m."refId" = ${agentId}
        AND g."holder" IS NOT NULL AND g."expiresAt" IS NOT NULL AND g."expiresAt" > ${now}
        AND g."confirmedTerm" = g."term" AND g."confirmedHolder" = g."holder"
    `)
    return rows.map((r) => r.holder as DaemonId).sort()
  }

  async holdersOf(agentId: AgentId, now: Date): Promise<DaemonId[]> {
    // Same unexpired-lease join as holdsAgent, read from the agent's side: an
    // update must reach every member actually serving it. Membership survives an
    // agent delete (no FK), so `agent/remove` still finds the holder.
    const rows = await this.prisma.$queryRaw<{ holder: string }[]>(Prisma.sql`
      SELECT DISTINCT g."holder" AS holder FROM "duty_group_member" m
      JOIN "duty_group" g ON g.id = m."groupId"
      WHERE m."kind" = 'agent' AND m."refId" = ${agentId}
        AND g."holder" IS NOT NULL AND g."expiresAt" IS NOT NULL AND g."expiresAt" > ${now}
    `)
    return rows.map((r) => r.holder as DaemonId).sort()
  }

  async heldAgentIds(holder: DaemonId, now: Date): Promise<AgentId[]> {
    const rows = await this.prisma.$queryRaw<{ refId: string }[]>(Prisma.sql`
      SELECT DISTINCT m."refId" FROM "duty_group_member" m
      JOIN "duty_group" g ON g.id = m."groupId"
      WHERE m."kind" = 'agent'
        AND g."holder" = ${holder}::uuid AND g."expiresAt" IS NOT NULL AND g."expiresAt" > ${now}
    `)
    return rows.map((r) => r.refId as AgentId).sort()
  }

  async claimAgentHome(
    orgId: OrgId,
    agentId: AgentId,
    holder: DaemonId,
    now: Date,
    leaseMs: number
  ): Promise<AgentHomeClaim> {
    const expiresAt = new Date(now.getTime() + leaseMs)
    // The rollout barrier rides every write below that CREATES or TAKES a lease, in the statement
    // itself, so a registration committing mid-transaction cannot let an older member take a home.
    const generationGate = noNewerGenerationLive(Prisma.sql`${holder}::uuid`, new Date(now.getTime() - leaseMs))
    return withTx(this.prisma, async (tx) => {
      // Org scope fences row creation against applyReconcile; the FOR UPDATE row
      // lock below fences the lease against claimVacant/renewHeld/release.
      await lockOrgDutyScope(tx, orgId)
      // The membership fence: eligibility is a `member_set_member` lookup, so a withdrawal that
      // decided this member was idle must not have a lease appear under it afterwards.
      await lockDaemonMembership(tx, holder)
      // The rendezvous is a claim path, so it takes the same eligibility gate — inside the
      // transaction, against the live row, because this path can MINT a group and a check made
      // before the lock would let a member reach through it for an agent it may not hold. The
      // capability gate rides with it, per agent, exactly as `claimVacant` carries it per group: a
      // trigger reaching a member of an older image is not authority to serve a platform it has no
      // module for.
      const [eligible] = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
        SELECT (${eligibleAgent(Prisma.sql`a`, Prisma.sql`${holder}::uuid`)}
                AND ${servesAgentPlatforms(Prisma.sql`a.id`, Prisma.sql`${holder}::uuid`)}) AS ok
        FROM "agent" a WHERE a.id = ${agentId}::uuid
      `)
      if (eligible?.ok !== true) return { granted: false, holder: null }
      const member = await tx.dutyGroupMember.findUnique({ where: { kind_refId: { kind: 'agent', refId: agentId } } })
      if (!member) {
        // Claiming creates the lease: the first trigger for a botless agent — gated like a claim.
        const groupId = this.mintId()
        const minted = await tx.$executeRaw(Prisma.sql`
          INSERT INTO "duty_group" (id, "orgId", "holder", "term", "expiresAt", "createdAt", "updatedAt")
          SELECT ${groupId}::uuid, ${orgId}, ${holder}::uuid, 1, ${expiresAt}, ${now}, ${now}
          WHERE ${generationGate}
        `)
        if (minted !== 1) return { granted: false, holder: null }
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
        // Vacancy re-asserted in the write despite the row lock — belt and braces — and the
        // rollout barrier in the same statement. Same rule as `claimVacant`: the term bump leaves
        // the grant unconfirmed by construction, including for the member that just lost it.
        const won = await tx.$executeRaw(Prisma.sql`
          UPDATE "duty_group" SET "holder" = ${holder}::uuid, "term" = "term" + 1, "expiresAt" = ${expiresAt}, "updatedAt" = ${now}
          WHERE id = ${row.id}::uuid AND ("holder" IS NULL OR "expiresAt" IS NULL OR "expiresAt" < ${now})
            AND ${generationGate}
        `)
        if (won === 1) {
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
