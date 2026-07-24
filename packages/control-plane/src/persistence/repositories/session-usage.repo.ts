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
import type { SessionUsageRepo, SessionUsageInput, UsageAggregate, AgentUsageAggregate, ViewCtx } from '../ports.js'
import { visibilityWhere } from '../ports.js'
import type { OrgId } from '../../domain/ids.js'

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
    await this.db.sessionUsage.upsert({
      where: { agentId_sessionId: { agentId: input.agentId, sessionId: input.sessionId } },
      // `startedAt` defaults to now() on first insert (the session's first-seen);
      // never touched on update, so it stays the earliest report.
      create: { agentId: input.agentId, sessionId: input.sessionId, ...fields },
      update: fields
    })
  }

  async aggregate(orgId: OrgId, since: Date, viewer?: ViewCtx): Promise<UsageAggregate> {
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

    return { totals: { ...totals, costCurrency }, agents }
  }
}
