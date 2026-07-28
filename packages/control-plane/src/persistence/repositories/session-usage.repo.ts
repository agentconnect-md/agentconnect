/**
 * PgSessionUsageRepo — per-session token accounting for the console usage
 * dashboard (see the `SessionUsage` model + `usage/report` EVT).
 *
 * `record` is a latest-wins upsert on `(agentId, sessionId)`: the daemon reports
 * the session's CUMULATIVE snapshot, so re-sending the same numbers is a no-op.
 * `aggregate` sums over sessions active in a time window, grouped by agent, and
 * is org-scoped through the `agent` relation. Token columns are `Int` per row
 * (a single session won't exceed 2^31), but Postgres `SUM(int)` returns `bigint`;
 * Prisma surfaces these `_sum` values as `number` (safe to 2^53), which is plenty
 * for workspace-wide token totals.
 */
import type { PrismaLike } from '../prisma.js'
import type {
  SessionUsageRepo,
  SessionUsageInput,
  SessionUsageCounts,
  UsageAggregate,
  AgentUsageAggregate,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../ports.js'
import type { AgentId, OrgId } from '../../domain/ids.js'

export class PgSessionUsageRepo implements SessionUsageRepo {
  constructor(private readonly db: PrismaLike) {}

  async record(input: SessionUsageInput): Promise<void> {
    const u = input.usage
    // Only-provided fields win; absent counts default to 0 (or null for the
    // context/cost snapshot), so a runtime that reports partial usage is fine.
    const fields = {
      platform: input.platform ?? null,
      channel: input.channel ?? null,
      totalTokens: u.totalTokens ?? 0,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      thoughtTokens: u.thoughtTokens ?? 0,
      cachedReadTokens: u.cachedReadTokens ?? 0,
      cachedWriteTokens: u.cachedWriteTokens ?? 0,
      contextUsed: u.contextUsed ?? null,
      contextSize: u.contextSize ?? null,
      costAmount: u.costAmount ?? 0,
      costCurrency: u.costCurrency ?? null,
      lastActivityAt: input.lastActivityAt
    }
    const key = { agentId_sessionId: { agentId: input.agentId, sessionId: input.sessionId } }
    // Snapshot upsert + spend-ledger append commit together. The daemon reports
    // CUMULATIVE cost, so the ledger delta = new − prior snapshot; we append it
    // stamped at the report's activity time so the spend-over-time series can
    // bucket it where it happened (the snapshot alone collapses a session's whole
    // cost into its newest bucket). Cost only grows ⇒ delta ≥ 0; a re-send or a
    // reset yields ≤ 0 and appends nothing, keeping the ledger idempotent.
    // ponytail: the read-then-write assumes reports for one session are serialized
    // (a single active turn at a time — true today). If concurrent same-session
    // reports ever happen, lock the prior-cost read with SELECT … FOR UPDATE so
    // two deltas can't both diff against the same stale snapshot and double-count.
    const apply = async (tx: PrismaLike) => {
      const prev = await tx.sessionUsage.findUnique({ where: key, select: { costAmount: true } })
      // `startedAt` defaults to now() on first insert (the session's first-seen);
      // never touched on update, so it stays the earliest report.
      await tx.sessionUsage.upsert({
        where: key,
        create: { agentId: input.agentId, sessionId: input.sessionId, ...fields },
        update: fields
      })
      const delta = fields.costAmount - (prev?.costAmount ?? 0)
      if (delta > 0) {
        await tx.sessionSpend.create({
          data: { agentId: input.agentId, sessionId: input.sessionId, at: input.lastActivityAt, costAmount: delta }
        })
      }
    }
    // `record` is called with the full client (never inside a withTx), so open our
    // own transaction; the narrow keeps it composable if that ever changes.
    if ('$transaction' in this.db) await this.db.$transaction(apply)
    else await apply(this.db)
  }

  async get(agentId: AgentId, sessionId: string): Promise<SessionUsageCounts | null> {
    const usage = await this.db.sessionUsage.findUnique({
      where: { agentId_sessionId: { agentId, sessionId } }
    })
    if (!usage) return null
    return {
      reportedAt: usage.lastActivityAt.toISOString(),
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thoughtTokens: usage.thoughtTokens,
      cachedReadTokens: usage.cachedReadTokens,
      cachedWriteTokens: usage.cachedWriteTokens,
      ...(usage.contextUsed !== null ? { contextUsed: usage.contextUsed } : {}),
      ...(usage.contextSize !== null ? { contextSize: usage.contextSize } : {}),
      ...(usage.costAmount !== 0 || usage.costCurrency ? { costAmount: usage.costAmount } : {}),
      ...(usage.costCurrency ? { costCurrency: usage.costCurrency } : {})
    }
  }

  async aggregate(orgId: OrgId, since: Date, viewer?: ViewCtx, tzOffsetMin = 0): Promise<UsageAggregate> {
    // Derived visibility: usage rows inherit their agent's visibility, so scope
    // through the `agent` relation. A restricted agent a non-viewer can't see then
    // drops out of BOTH the per-agent breakdown and the totals (owner/undefined ⇒
    // unfiltered — governance override).
    const agentScope = { orgId, ...visibilityWhere(viewer) }
    const grouped = await this.db.sessionUsage.groupBy({
      by: ['agentId'],
      where: { agent: agentScope, lastActivityAt: { gte: since } },
      _sum: {
        totalTokens: true,
        inputTokens: true,
        outputTokens: true,
        thoughtTokens: true,
        cachedReadTokens: true,
        cachedWriteTokens: true,
        costAmount: true
      },
      _count: { _all: true }
    })

    const agents: AgentUsageAggregate[] = grouped.map((g) => ({
      agentId: g.agentId,
      sessions: g._count._all,
      totalTokens: g._sum.totalTokens ?? 0,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      thoughtTokens: g._sum.thoughtTokens ?? 0,
      cachedReadTokens: g._sum.cachedReadTokens ?? 0,
      cachedWriteTokens: g._sum.cachedWriteTokens ?? 0,
      costAmount: g._sum.costAmount ?? 0
    }))
    // Sort by token spend so the console's "top agents" ordering is stable.
    agents.sort((a, b) => b.totalTokens - a.totalTokens)

    const totals = agents.reduce(
      (acc, a) => ({
        sessions: acc.sessions + a.sessions,
        totalTokens: acc.totalTokens + a.totalTokens,
        costAmount: acc.costAmount + a.costAmount
      }),
      { sessions: 0, totalTokens: 0, costAmount: 0 }
    )

    // Cost currency for the range: the single distinct currency reported. `null`
    // when none or mixed — amounts are summed as-is, so a mixed-currency workspace
    // surfaces an unlabeled total (a known limitation until per-currency rollups).
    const currencies = await this.db.sessionUsage.findMany({
      where: { agent: agentScope, lastActivityAt: { gte: since }, costCurrency: { not: null } },
      distinct: ['costCurrency'],
      select: { costCurrency: true }
    })
    const costCurrency = currencies.length === 1 ? currencies[0]!.costCurrency : null

    // Spend-over-time series: sum the append-only spend ledger's INCREMENTAL
    // deltas into the bucket each report landed in, then fill empty buckets with 0
    // across the whole window. Reading the ledger (not the cumulative snapshot)
    // keeps a session's spend in the buckets it actually happened in. d1 buckets
    // hourly, longer ranges daily. Buckets align to the viewer's LOCAL
    // day/hour: we shift into local time (subtract offMs), floor there, shift back
    // — so `start` is the UTC instant of a local boundary and the client labels it
    // in local tz. offMs is 0 ⇒ plain UTC.
    // ponytail: one current offset applied across the whole window — a DST change
    // mid-range misattributes the ~1h around the switch; acceptable for a spend
    // chart, pass an IANA tz + date_trunc if hour-exact local days ever matter.
    // ponytail: buckets in JS over the range's rows — fine for a workspace's
    // session volume; switch to a date_trunc GROUP BY if a range ever returns
    // 100k+ rows.
    const HOUR_MS = 60 * 60 * 1000
    const offMs = tzOffsetMin * 60 * 1000
    const now = Date.now()
    const bucket: 'hour' | 'day' = now - since.getTime() <= 2 * 24 * HOUR_MS ? 'hour' : 'day'
    const stepMs = bucket === 'hour' ? HOUR_MS : 24 * HOUR_MS
    // Floor `since` to the start of its local bucket, expressed as a UTC instant.
    const floorSince = Math.floor((since.getTime() - offMs) / stepMs) * stepMs + offMs
    const n = Math.floor((now - floorSince) / stepMs) + 1
    const points: { start: string; costAmount: number }[] = Array.from({ length: n }, (_, i) => ({
      start: new Date(floorSince + i * stepMs).toISOString(),
      costAmount: 0
    }))
    const spendRows = await this.db.sessionSpend.findMany({
      where: { agent: agentScope, at: { gte: since } },
      select: { at: true, costAmount: true }
    })
    for (const row of spendRows) {
      const idx = Math.floor((row.at.getTime() - floorSince) / stepMs)
      if (idx >= 0 && idx < n) points[idx]!.costAmount += row.costAmount
    }

    return { totals: { ...totals, costCurrency }, agents, series: { bucket, points } }
  }
}
