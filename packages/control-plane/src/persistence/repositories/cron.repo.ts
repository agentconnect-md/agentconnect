/**
 * PgCronRepo — cron definitions (design §3.11, §3.14).
 *
 * A cron drives ONE agent. `upsert` is keyed on cronId so `cron/upsert` re-apply
 * is idempotent (the CP owns the definition). `listForDaemon` builds the
 * per-daemon `register/ok.crons[]` (crons of agents placed on that daemon —
 * same scope rule as integrations); `listForOrg` backs the console list.
 * `lastRunAt` here is advisory — the daemon is authoritative for firing.
 */
import type { Platform } from '@agentconnect.md/protocol'
import { Prisma, type CronDef, type User } from '../../generated/prisma/client.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type { CronRepo, CronRecord, CronReportInput, CronRunRecord, UpsertCronInput, ViewCtx } from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { toDbPlatform } from '../platform.js'
import { AgentId, CronId, IntegrationId, OrgId, type DaemonId } from '../../domain/ids.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { CronMissing } from '../errors.js'

/** Serialize every mutation of one client-minted cron id, including an absent row. */
async function lockCronMutationScope(tx: Prisma.TransactionClient, cronId: CronId): Promise<void> {
  const key = JSON.stringify(['cron-upsert', cronId])
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `)
}

// The cron row plus its joined creator + last-modifier users — reads surface both
// for the console (same model as agents/daemons).
type CronWithUsers = CronDef & { createdBy: User | null; lastModifiedBy: User | null }
const withUsers = { createdBy: true, lastModifiedBy: true } as const

function toRecord(c: CronWithUsers): CronRecord {
  return {
    id: CronId(c.id),
    orgId: OrgId(c.orgId),
    agentId: c.agentId ? AgentId(c.agentId) : null,
    name: c.name,
    schedule: c.schedule,
    timezone: c.timezone,
    targetPlatform: c.targetPlatform as Platform,
    targetChannel: c.targetChannel,
    targetIntegrationId: c.targetIntegrationId ? IntegrationId(c.targetIntegrationId) : null,
    trigger: c.trigger,
    enabled: c.enabled,
    lastRunAt: c.lastRunAt,
    createdBy: c.createdBy
      ? { userId: c.createdBy.id, displayName: c.createdBy.displayName, email: c.createdBy.email }
      : null,
    createdByUserId: c.createdByUserId,
    visibility: c.visibility,
    sharedWith: c.sharedWith,
    createdAt: c.createdAt,
    lastModifiedAt: c.lastModifiedAt,
    lastModifiedBy: c.lastModifiedBy
      ? { userId: c.lastModifiedBy.id, displayName: c.lastModifiedBy.displayName, email: c.lastModifiedBy.email }
      : null
  }
}

export class PgCronRepo implements CronRepo {
  constructor(private readonly db: PrismaLike) {}

  async upsert(input: UpsertCronInput): Promise<CronRecord> {
    const data = {
      orgId: input.orgId,
      agentId: input.agentId,
      name: input.name ?? null,
      schedule: input.schedule,
      timezone: input.timezone,
      targetPlatform: toDbPlatform(input.targetPlatform ?? 'slack'),
      targetChannel: input.targetChannel ?? null,
      targetIntegrationId: input.targetIntegrationId ?? null,
      trigger: input.trigger,
      enabled: input.enabled ?? true
    }
    return withAmbientTx(this.db, async (tx) => {
      // Serialize on the client-minted id before the org fence so concurrent creation cannot take over the row.
      await lockCronMutationScope(tx, input.cronId)
      const owner = await tx.cronDef.findUnique({ where: { id: input.cronId }, select: { orgId: true } })
      if (owner && owner.orgId !== input.orgId) throw new CronMissing(input.cronId)
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: input.orgId,
        visibility: input.visibility ?? 'org',
        actorUserId: input.lastModifiedByUserId ?? input.createdByUserId,
        sharedWith: input.sharedWith
      })
      const c = await tx.cronDef.upsert({
        where: { id: input.cronId },
        // Creator only on CREATE — a later edit through the same PUT upsert never
        // reassigns the cron to its editor. The last-modified audit, by contrast,
        // is stamped on BOTH paths: on create the editor == creator; on edit it
        // advances to this upsert's actor.
        create: {
          id: input.cronId,
          ...data,
          ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
          ...(input.lastModifiedByUserId ? { lastModifiedByUserId: input.lastModifiedByUserId } : {}),
          // Initial visibility on create only; the update branch never touches
          // sharing — that goes through setSharing / PUT /sharing.
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(memberships.sharedWith ? { sharedWith: memberships.sharedWith } : {})
        },
        update: {
          ...data,
          lastModifiedAt: new Date(),
          ...(input.lastModifiedByUserId ? { lastModifiedByUserId: input.lastModifiedByUserId } : {})
        },
        include: withUsers
      })
      return toRecord(c)
    })
  }

  async setSharing(
    orgId: OrgId,
    cronId: CronId,
    sharing: { visibility: CronRecord['visibility']; sharedWith: string[] },
    byUserId?: string
  ): Promise<CronRecord> {
    return withAmbientTx(this.db, async (tx) => {
      // Org fence on the opening read: a cross-org id throws the same P2025 as
      // a missing row, before the membership lock or any write.
      const existing = await tx.cronDef.findUniqueOrThrow({
        where: { id: cronId, orgId },
        select: { orgId: true }
      })
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: existing.orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: sharing.sharedWith
      })
      // A sharing change is a human edit — advance the last-modified audit
      // (editor stamped when known; absent under devAuth ⇒ leave it unchanged).
      const c = await tx.cronDef.update({
        where: { id: cronId, orgId },
        data: {
          visibility: sharing.visibility,
          sharedWith: memberships.sharedWith ?? [],
          lastModifiedAt: new Date(),
          ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
        },
        include: withUsers
      })
      return toRecord(c)
    })
  }

  async remove(orgId: OrgId, cronId: CronId, expectedAgentId: AgentId | null): Promise<boolean> {
    return withAmbientTx(this.db, async (tx) => {
      await lockCronMutationScope(tx, cronId)
      const current = await tx.cronDef.findUnique({ where: { id: cronId, orgId }, select: { agentId: true } })
      if (current && current.agentId !== expectedAgentId) return false
      await tx.cronDef.delete({ where: { id: cronId, orgId } })
      return true
    })
  }

  async listForOrg(orgId: OrgId, viewer?: ViewCtx): Promise<CronRecord[]> {
    const rows = await this.db.cronDef.findMany({
      where: { orgId, ...visibilityWhere(viewer) },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listForAgent(agentId: AgentId): Promise<CronRecord[]> {
    const rows = await this.db.cronDef.findMany({
      where: { agentId },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listForAgents(agentIds: readonly string[]): Promise<CronRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.cronDef.findMany({
      where: { agentId: { in: [...agentIds] } },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listForDaemon(daemonId: DaemonId): Promise<CronRecord[]> {
    // Via the agent relation: only crons whose owning agent is placed on this
    // daemon. Orphaned rows (agentId null) match no daemon — inert by design.
    const rows = await this.db.cronDef.findMany({
      where: { agent: { daemonId } },
      include: withUsers,
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async get(orgId: OrgId, cronId: CronId): Promise<CronRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const c = await this.db.cronDef.findUnique({ where: { id: cronId, orgId }, include: withUsers })
    return c ? toRecord(c) : null
  }

  async recordReport(cronId: CronId, r: CronReportInput): Promise<boolean> {
    // The reporting daemon's authority is settled by the caller against the resolver (placement ∪
    // live duty holders); a join on `agent.daemonId` here dropped every pool member's report.
    const cron = await this.db.cronDef.findUnique({ where: { id: cronId }, select: { id: true, orgId: true } })
    if (!cron) return false
    // lastRunAt is latest-wins: an older firedAt (reconnect re-assert,
    // out-of-order delivery) never regresses the stamp.
    await this.db.cronDef.updateMany({
      where: { id: cronId, OR: [{ lastRunAt: null }, { lastRunAt: { lt: r.firedAt } }] },
      data: { lastRunAt: r.firedAt }
    })
    // Run row keyed on (cronId, firedAt): the fire report opens it (`running`),
    // a session progress report adds the deep-link without closing it, and the
    // completion report closes it — and still creates it if earlier reports
    // were lost. A plain fire re-assert never resets either field.
    const key = { cronId_startedAt: { cronId, startedAt: r.firedAt } }
    if (!r.status) {
      const progress = r.sessionId ? { sessionId: r.sessionId } : {}
      await this.db.cronRun.upsert({
        where: key,
        create: { cronId, orgId: cron.orgId, startedAt: r.firedAt, ...progress },
        update: progress
      })
    } else {
      const outcome = {
        status: r.status,
        durationMs: r.durationMs ?? null,
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        reason: r.reason ?? null
      }
      await this.db.cronRun.upsert({
        where: key,
        create: { cronId, orgId: cron.orgId, startedAt: r.firedAt, ...outcome },
        update: outcome
      })
    }
    return true
  }

  async listRuns(orgId: OrgId, cronId: CronId, limit = 50): Promise<CronRunRecord[]> {
    // Run rows carry their own `orgId`, so the fence rides this query rather
    // than resting solely on the parent cron's (org-scoped-data-layer.md §3.6).
    const rows = await this.db.cronRun.findMany({
      where: { cronId, orgId },
      orderBy: { startedAt: 'desc' },
      take: limit
    })
    return rows.map((r) => ({
      id: r.id,
      cronId: CronId(r.cronId),
      startedAt: r.startedAt,
      status: r.status,
      durationMs: r.durationMs,
      sessionId: r.sessionId,
      reason: r.reason
    }))
  }

  async reapStaleRuns(staleBefore: Date): Promise<number> {
    // Fail only rows still `running` past the cutoff; terminal rows are left as
    // they are, and a late completion report re-closes a reaped row with the real
    // outcome (recordReport's upsert `update` is unconditional).
    const res = await this.db.cronRun.updateMany({
      where: { status: 'running', startedAt: { lt: staleBefore } },
      data: { status: 'failed', reason: ORPHANED_RUN_REASON }
    })
    return res.count
  }
}

// Marker set on a run whose completion report never arrived (the reaper closed
// it). Kept short — surfaced verbatim in the console run detail.
export const ORPHANED_RUN_REASON = 'no completion report (daemon offline or restarted at turn end)'
