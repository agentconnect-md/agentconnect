/**
 * PgSessionUsageRepo — per-session token accounting for the console usage
 * dashboard (see the `SessionUsage` model + `usage/report` EVT).
 *
 * `record` latest-wins upserts the `(agentId, sessionId)` snapshot AND upserts the
 * session's CUMULATIVE cost at this report time into the `SessionSpend` timeline —
 * both idempotent, so re-sending or racing the same numbers is a no-op.
 * `aggregate` reports tokens/session-counts from the snapshot but derives every
 * range-scoped COST figure (total, per-agent, and the spend-over-time chart) from
 * the timeline by diffing consecutive cumulatives, so the cards and chart agree
 * and pre-window spend is excluded. It is org-scoped through the `agent` relation.
 * Token columns are `Int` per row
 * (a single session won't exceed 2^31), but Postgres `SUM(int)` returns `bigint`;
 * Prisma surfaces these `_sum` values as `number` (safe to 2^53), which is plenty
 * for workspace-wide token totals.
 */
import type { PrismaLike } from '../prisma.js'
import { Prisma } from '../../generated/prisma/client.js'
import type {
  SessionUsageRepo,
  SessionUsageInput,
  SessionUsageCounts,
  UsageAggregate,
  AgentUsageAggregate,
  ViewCtx,
  SessionFilterQuery
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { sessionViewerSql } from './session-access-sql.js'

function agentViewerSql(orgId: OrgId, viewer?: ViewCtx): Prisma.Sql {
  const visible = viewer
    ? Prisma.sql`(
        a."visibility" = 'org'::"ResourceVisibility"
        OR ${viewer.userId} = ANY(a."sharedWith")
      )`
    : Prisma.sql`TRUE`
  return Prisma.sql`a."orgId" = ${orgId} AND ${visible}`
}

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
    // `startedAt` defaults to now() on first insert (the session's first-seen);
    // never touched on update, so it stays the earliest report.
    await this.db.sessionUsage.upsert({
      where: key,
      create: { agentId: input.agentId, sessionId: input.sessionId, ...fields },
      update: fields
    })
    // Spend timeline: record this report's CUMULATIVE cost stamped at its activity
    // time. Readers derive window/bucket spend by diffing consecutive cumulatives
    // (aggregate), so storing cumulative — not a computed delta — makes this a pure
    // idempotent upsert on (agentId, sessionId, at): a duplicate delivery, an
    // out-of-order report, or two concurrent reports converge to the same rows
    // with no read-then-write race and no double-count. A downward correction is
    // just a lower cumulative here; the diff turns it into negative spend in its
    // own bucket, which nets out correctly against later increases.
    await this.db.sessionSpend.upsert({
      where: {
        agentId_sessionId_at: { agentId: input.agentId, sessionId: input.sessionId, at: input.lastActivityAt }
      },
      create: {
        agentId: input.agentId,
        sessionId: input.sessionId,
        at: input.lastActivityAt,
        cumulativeCost: fields.costAmount
      },
      update: { cumulativeCost: fields.costAmount }
    })
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

  async aggregate(
    orgId: OrgId,
    since: Date,
    viewer?: ViewCtx,
    tzOffsetMin = 0,
    sessionViewer?: SessionFilterQuery['viewer']
  ): Promise<UsageAggregate> {
    // Derived visibility: usage rows inherit their agent's visibility, so scope
    // through the `agent` relation. A restricted agent the caller cannot see
    // drops out of BOTH the per-agent breakdown and the totals. Organization
    // roles never widen that resource-level visibility.
    const agentScope = { orgId, ...visibilityWhere(viewer) }
    // Tokens + session counts come from the lifetime snapshot (tokens aren't
    // time-attributed). Cost is deliberately NOT summed here — every range-scoped
    // cost figure (the total, each agent's spend, and the chart) is derived from
    // the spend timeline below, so the cards and the chart can never disagree.
    const sessionScope = sessionViewerSql(sessionViewer)
    const grouped = sessionScope
      ? await this.db.$queryRaw<
          Array<{
            agentId: string
            sessions: bigint
            totalTokens: bigint
            inputTokens: bigint
            outputTokens: bigint
            thoughtTokens: bigint
            cachedReadTokens: bigint
            cachedWriteTokens: bigint
          }>
        >(Prisma.sql`
          SELECT u."agentId",
                 COUNT(*)::bigint AS sessions,
                 COALESCE(SUM(u."totalTokens"), 0)::bigint AS "totalTokens",
                 COALESCE(SUM(u."inputTokens"), 0)::bigint AS "inputTokens",
                 COALESCE(SUM(u."outputTokens"), 0)::bigint AS "outputTokens",
                 COALESCE(SUM(u."thoughtTokens"), 0)::bigint AS "thoughtTokens",
                 COALESCE(SUM(u."cachedReadTokens"), 0)::bigint AS "cachedReadTokens",
                 COALESCE(SUM(u."cachedWriteTokens"), 0)::bigint AS "cachedWriteTokens"
          FROM "session_usage" u
          JOIN "agent" a ON a."id" = u."agentId"
          JOIN "session_meta" s ON s."id" = u."sessionId" AND s."agentId" = u."agentId"
          WHERE ${agentViewerSql(orgId, viewer)}
            AND u."lastActivityAt" >= ${since}
            AND ${sessionScope}
          GROUP BY u."agentId"
        `)
      : (
          await this.db.sessionUsage.groupBy({
            by: ['agentId'],
            where: { agent: agentScope, lastActivityAt: { gte: since } },
            _sum: {
              totalTokens: true,
              inputTokens: true,
              outputTokens: true,
              thoughtTokens: true,
              cachedReadTokens: true,
              cachedWriteTokens: true
            },
            _count: { _all: true }
          })
        ).map((row) => ({
          agentId: row.agentId,
          sessions: BigInt(row._count._all),
          totalTokens: BigInt(row._sum.totalTokens ?? 0),
          inputTokens: BigInt(row._sum.inputTokens ?? 0),
          outputTokens: BigInt(row._sum.outputTokens ?? 0),
          thoughtTokens: BigInt(row._sum.thoughtTokens ?? 0),
          cachedReadTokens: BigInt(row._sum.cachedReadTokens ?? 0),
          cachedWriteTokens: BigInt(row._sum.cachedWriteTokens ?? 0)
        }))

    // Bucket geometry: d1 buckets hourly, longer ranges daily. Buckets align to the
    // viewer's LOCAL day/hour: we shift into local time (subtract offMs), floor
    // there, shift back — so `start` is the UTC instant of a local boundary and the
    // client labels it in local tz. offMs is 0 ⇒ plain UTC.
    // ponytail: one current offset applied across the whole window — a DST change
    // mid-range misattributes the ~1h around the switch; acceptable for a spend
    // chart, pass an IANA tz + date_trunc if hour-exact local days ever matter.
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

    // Spend timeline → range spend by DIFFING consecutive cumulatives per session.
    // A session's window spend is (its latest in-window cumulative) − (its cumulative
    // just before the window), split across buckets by when each increase landed:
    // for each in-window report, delta = cumulative − the session's previous
    // cumulative (the pre-window baseline row for its first in-window report), and
    // that delta feeds the bucket, the agent, and the total together. Pre-window
    // spend is thus excluded, replays contribute 0 (cumulative unchanged), and a
    // downward correction contributes negative spend that nets out — the same
    // numbers the cards and the chart both show.
    // ponytail: diff walked in JS over the window's rows plus one pre-window
    // baseline row per session — fine for a workspace's report volume; move to a
    // SQL window function (LAG over cumulative) if a range ever returns 100k+ rows.
    const SEP = '\0'
    const [inRange, baselineRows] = sessionScope
      ? await Promise.all([
          this.db.$queryRaw<Array<{ agentId: string; sessionId: string; at: Date; cumulativeCost: number }>>(Prisma.sql`
            SELECT sp."agentId", sp."sessionId", sp."at", sp."cumulativeCost"
            FROM "session_spend" sp
            JOIN "agent" a ON a."id" = sp."agentId"
            JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
            WHERE ${agentViewerSql(orgId, viewer)} AND sp."at" >= ${since} AND ${sessionScope}
            ORDER BY sp."at" ASC
          `),
          this.db.$queryRaw<Array<{ agentId: string; sessionId: string; cumulativeCost: number }>>(Prisma.sql`
            SELECT DISTINCT ON (sp."agentId", sp."sessionId")
                   sp."agentId", sp."sessionId", sp."cumulativeCost"
            FROM "session_spend" sp
            JOIN "agent" a ON a."id" = sp."agentId"
            JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
            WHERE ${agentViewerSql(orgId, viewer)} AND sp."at" < ${since} AND ${sessionScope}
            ORDER BY sp."agentId", sp."sessionId", sp."at" DESC
          `)
        ])
      : await Promise.all([
          this.db.sessionSpend.findMany({
            where: { agent: agentScope, at: { gte: since } },
            select: { agentId: true, sessionId: true, at: true, cumulativeCost: true },
            orderBy: { at: 'asc' }
          }),
          this.db.sessionSpend.findMany({
            where: { agent: agentScope, at: { lt: since } },
            distinct: ['agentId', 'sessionId'],
            orderBy: [{ agentId: 'asc' }, { sessionId: 'asc' }, { at: 'desc' }],
            select: { agentId: true, sessionId: true, cumulativeCost: true }
          })
        ])
    // Per-session running cumulative, seeded from the last pre-window report so the
    // first in-window delta counts only spend incurred inside the window.
    const prevCost = new Map<string, number>(baselineRows.map((r) => [r.agentId + SEP + r.sessionId, r.cumulativeCost]))
    const perAgentCost = new Map<string, number>()
    let totalCost = 0
    // `inRange` is globally at-ascending, so each session's rows are visited in
    // chronological order — exactly what the running diff needs.
    for (const row of inRange) {
      const skey = row.agentId + SEP + row.sessionId
      const delta = row.cumulativeCost - (prevCost.get(skey) ?? 0)
      prevCost.set(skey, row.cumulativeCost)
      totalCost += delta
      perAgentCost.set(row.agentId, (perAgentCost.get(row.agentId) ?? 0) + delta)
      const idx = Math.floor((row.at.getTime() - floorSince) / stepMs)
      if (idx >= 0 && idx < n) points[idx]!.costAmount += delta
    }

    const agents: AgentUsageAggregate[] = grouped.map((g) => ({
      agentId: g.agentId,
      sessions: Number(g.sessions),
      totalTokens: Number(g.totalTokens),
      inputTokens: Number(g.inputTokens),
      outputTokens: Number(g.outputTokens),
      thoughtTokens: Number(g.thoughtTokens),
      cachedReadTokens: Number(g.cachedReadTokens),
      cachedWriteTokens: Number(g.cachedWriteTokens),
      costAmount: perAgentCost.get(g.agentId) ?? 0
    }))
    // Sort by token spend so the console's "top agents" ordering is stable.
    agents.sort((a, b) => b.totalTokens - a.totalTokens)

    const totals = agents.reduce(
      (acc, a) => ({
        sessions: acc.sessions + a.sessions,
        totalTokens: acc.totalTokens + a.totalTokens
      }),
      { sessions: 0, totalTokens: 0 }
    )

    // Cost currency for the range: the single distinct currency reported. `null`
    // when none or mixed — amounts are summed as-is, so a mixed-currency workspace
    // surfaces an unlabeled total (a known limitation until per-currency rollups).
    const currencies = sessionScope
      ? await this.db.$queryRaw<Array<{ costCurrency: string }>>(Prisma.sql`
          SELECT DISTINCT u."costCurrency"
          FROM "session_usage" u
          JOIN "agent" a ON a."id" = u."agentId"
          JOIN "session_meta" s ON s."id" = u."sessionId" AND s."agentId" = u."agentId"
          WHERE ${agentViewerSql(orgId, viewer)}
            AND u."lastActivityAt" >= ${since}
            AND u."costCurrency" IS NOT NULL
            AND ${sessionScope}
        `)
      : await this.db.sessionUsage.findMany({
          where: { agent: agentScope, lastActivityAt: { gte: since }, costCurrency: { not: null } },
          distinct: ['costCurrency'],
          select: { costCurrency: true }
        })
    const costCurrency = currencies.length === 1 ? currencies[0]!.costCurrency : null

    return { totals: { ...totals, costAmount: totalCost, costCurrency }, agents, series: { bucket, points } }
  }
}
