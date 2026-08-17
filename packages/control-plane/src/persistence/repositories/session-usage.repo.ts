/**
 * PgSessionUsageRepo — per-session token accounting for the console usage
 * dashboard (see the `SessionUsage` model + `usage/report` EVT).
 *
 * `record` latest-wins upserts the `(agentId, sessionId)` snapshot AND upserts the
 * session's cumulative tokens/cost plus its observed model into the timeline —
 * both idempotent, so re-sending or racing the same numbers is a no-op. A LATE
 * report still lands its own timeline checkpoint but cannot roll the snapshot back.
 * `aggregate` reports tokens/session-counts from the snapshot but derives every
 * range-scoped COST figure (total, per-agent/model, and the spend-over-time chart)
 * from the timeline by diffing consecutive cumulatives, so the cards and chart agree
 * and pre-window spend is excluded. It is org-scoped through the `agent` relation.
 * Token columns are `Int` per row
 * (a single session won't exceed 2^31), but Postgres `SUM(int)` returns `bigint`;
 * Prisma surfaces these `_sum` values as `number` (safe to 2^53), which is plenty
 * for workspace-wide token totals.
 *
 * COST is the exception to all of that: it is `NUMERIC(38,18)` and every diff and sum
 * below runs on `Decimal`, never on a JS number. Billing reads these aggregates, so a
 * float anywhere in the roll-up would be a rounding error in someone's invoice.
 */
import type { PrismaLike } from '../prisma.js'
import { Prisma } from '../../generated/prisma/client.js'
import type { DecimalAmount } from '@agentconnect.md/protocol'
import type {
  SessionUsageRepo,
  SessionUsageInput,
  SessionUsageCounts,
  UsageAggregate,
  AgentUsageAggregate,
  ModelUsageAggregate,
  SpendBucket,
  ViewCtx,
  SessionFilterQuery
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { sessionViewerSql } from './session-access-sql.js'

const ZERO = new Prisma.Decimal(0)

/** A bucket mid-accumulation: `Decimal` sums, keyed maps, serialized once at the end. */
interface DecimalBucket {
  start: string
  costAmount: Prisma.Decimal
  byAgent: Map<string, Prisma.Decimal>
  byModel: Map<string, Prisma.Decimal>
}

/** `Decimal` → the exact decimal string the aggregate returns. `toFixed()` never
 *  yields exponent notation; the trailing-zero trim is what makes it canonical.
 *  A derived delta may be negative until the checkpoint merge fences it, so this
 *  keeps a sign rather than refusing the value a reader would then never see. */
function amount(value: Prisma.Decimal): DecimalAmount {
  const text = value.toFixed()
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** Serialize a keyed `Decimal` map for the response. */
function amounts(by: Map<string, Prisma.Decimal>): Record<string, DecimalAmount> {
  return Object.fromEntries([...by].map(([key, value]) => [key, amount(value)]))
}

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
    const f = {
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
      // Already the canonical decimal string (the ingress adapter normalized it);
      // it binds as text and Postgres casts it to the column's NUMERIC exactly.
      costAmount: u.costAmount ?? '0',
      costCurrency: u.costCurrency ?? null
    }
    // Both writes select through `agent`, so an agent deleted between metering and
    // reporting drops the report instead of raising a foreign-key error — one stale
    // report can never poison a batch (its rows would cascade away anyway).
    const owner = Prisma.sql`FROM "agent" a WHERE a."id" = ${input.agentId}::uuid`
    const source = Prisma.sql`${input.source}::"UsageSource"`
    // `startedAt` keeps its insert default (the session's first-seen) and is never
    // touched on update. The trailing predicate is the anti-regression fence: a LATE
    // report (an out-of-order delivery, or a slow retry overtaken by a newer one)
    // must not roll the snapshot back, while re-sending the SAME cumulative is still
    // an idempotent no-op write.
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "session_usage" (
        "agentId", "sessionId", "platform", "channel", "source",
        "totalTokens", "inputTokens", "outputTokens", "thoughtTokens",
        "cachedReadTokens", "cachedWriteTokens", "contextUsed", "contextSize",
        "costAmount", "costCurrency", "lastActivityAt", "updatedAt"
      )
      SELECT ${input.agentId}::uuid, ${input.sessionId}::text, ${f.platform}::text, ${f.channel}::text, ${source},
             ${f.totalTokens}::int, ${f.inputTokens}::int, ${f.outputTokens}::int, ${f.thoughtTokens}::int,
             ${f.cachedReadTokens}::int, ${f.cachedWriteTokens}::int, ${f.contextUsed}::int, ${f.contextSize}::int,
             ${f.costAmount}::numeric, ${f.costCurrency}::text, ${input.lastActivityAt}::timestamptz, NOW()
      ${owner}
      ON CONFLICT ("agentId", "sessionId") DO UPDATE SET
        "platform" = EXCLUDED."platform",
        "channel" = EXCLUDED."channel",
        "source" = EXCLUDED."source",
        "totalTokens" = EXCLUDED."totalTokens",
        "inputTokens" = EXCLUDED."inputTokens",
        "outputTokens" = EXCLUDED."outputTokens",
        "thoughtTokens" = EXCLUDED."thoughtTokens",
        "cachedReadTokens" = EXCLUDED."cachedReadTokens",
        "cachedWriteTokens" = EXCLUDED."cachedWriteTokens",
        "contextUsed" = EXCLUDED."contextUsed",
        "contextSize" = EXCLUDED."contextSize",
        "costAmount" = EXCLUDED."costAmount",
        "costCurrency" = EXCLUDED."costCurrency",
        "lastActivityAt" = EXCLUDED."lastActivityAt",
        "updatedAt" = NOW()
      WHERE "session_usage"."lastActivityAt" <= EXCLUDED."lastActivityAt"
    `)
    // Usage timeline: each report carries cumulative counters plus the model for
    // the interval that just ended. Readers diff consecutive rows, so model
    // switches retain their own deltas while duplicate deliveries stay idempotent.
    // A late report DOES write its own checkpoint — it belongs at its own `at`.
    await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "session_spend" (
        "agentId", "sessionId", "at", "model", "source",
        "cumulativeTotalTokens", "cumulativeInputTokens", "cumulativeOutputTokens",
        "cumulativeThoughtTokens", "cumulativeCachedReadTokens", "cumulativeCachedWriteTokens",
        "cumulativeCost"
      )
      SELECT ${input.agentId}::uuid, ${input.sessionId}::text, ${input.lastActivityAt}::timestamptz,
             ${input.model ?? null}::text, ${source},
             ${f.totalTokens}::int, ${f.inputTokens}::int, ${f.outputTokens}::int,
             ${f.thoughtTokens}::int, ${f.cachedReadTokens}::int, ${f.cachedWriteTokens}::int,
             ${f.costAmount}::numeric
      ${owner}
      ON CONFLICT ("agentId", "sessionId", "at") DO UPDATE SET
        "model" = EXCLUDED."model",
        "source" = EXCLUDED."source",
        "cumulativeTotalTokens" = EXCLUDED."cumulativeTotalTokens",
        "cumulativeInputTokens" = EXCLUDED."cumulativeInputTokens",
        "cumulativeOutputTokens" = EXCLUDED."cumulativeOutputTokens",
        "cumulativeThoughtTokens" = EXCLUDED."cumulativeThoughtTokens",
        "cumulativeCachedReadTokens" = EXCLUDED."cumulativeCachedReadTokens",
        "cumulativeCachedWriteTokens" = EXCLUDED."cumulativeCachedWriteTokens",
        "cumulativeCost" = EXCLUDED."cumulativeCost"
    `)
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
      // The session views only DISPLAY this one, so it degrades to a number here
      // rather than pushing the decimal string through every session read.
      ...(!usage.costAmount.isZero() || usage.costCurrency ? { costAmount: usage.costAmount.toNumber() } : {}),
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

    // Attribute lifetime token deltas to the model observed on each report. The
    // outer session_usage filter preserves the dashboard's established semantics:
    // a session active in the range contributes its lifetime token totals. One
    // session can legitimately count under multiple models after a sticky switch.
    const modelGrouped = await this.db.$queryRaw<
      Array<{
        model: string | null
        sessions: bigint
        totalTokens: bigint
        inputTokens: bigint
        outputTokens: bigint
        thoughtTokens: bigint
        cachedReadTokens: bigint
        cachedWriteTokens: bigint
      }>
    >(Prisma.sql`
      WITH ordered AS (
        SELECT sp."agentId", sp."sessionId", NULLIF(sp."model", '') AS model,
               sp."cumulativeTotalTokens"::bigint
                 - LAG(sp."cumulativeTotalTokens", 1, 0) OVER sample_order AS "totalTokens",
               sp."cumulativeInputTokens"::bigint
                 - LAG(sp."cumulativeInputTokens", 1, 0) OVER sample_order AS "inputTokens",
               sp."cumulativeOutputTokens"::bigint
                 - LAG(sp."cumulativeOutputTokens", 1, 0) OVER sample_order AS "outputTokens",
               sp."cumulativeThoughtTokens"::bigint
                 - LAG(sp."cumulativeThoughtTokens", 1, 0) OVER sample_order AS "thoughtTokens",
               sp."cumulativeCachedReadTokens"::bigint
                 - LAG(sp."cumulativeCachedReadTokens", 1, 0) OVER sample_order AS "cachedReadTokens",
               sp."cumulativeCachedWriteTokens"::bigint
                 - LAG(sp."cumulativeCachedWriteTokens", 1, 0) OVER sample_order AS "cachedWriteTokens"
        FROM "session_spend" sp
        JOIN "session_usage" u ON u."agentId" = sp."agentId" AND u."sessionId" = sp."sessionId"
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE ${agentViewerSql(orgId, viewer)}
          AND u."lastActivityAt" >= ${since}
          AND ${sessionScope ?? Prisma.sql`TRUE`}
        WINDOW sample_order AS (PARTITION BY sp."agentId", sp."sessionId" ORDER BY sp."at")
      )
      SELECT model,
             COUNT(DISTINCT ("agentId", "sessionId"))::bigint AS sessions,
             COALESCE(SUM("totalTokens"), 0)::bigint AS "totalTokens",
             COALESCE(SUM("inputTokens"), 0)::bigint AS "inputTokens",
             COALESCE(SUM("outputTokens"), 0)::bigint AS "outputTokens",
             COALESCE(SUM("thoughtTokens"), 0)::bigint AS "thoughtTokens",
             COALESCE(SUM("cachedReadTokens"), 0)::bigint AS "cachedReadTokens",
             COALESCE(SUM("cachedWriteTokens"), 0)::bigint AS "cachedWriteTokens"
      FROM ordered
      GROUP BY model
    `)

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
    // Buckets accumulate in `Decimal` and are serialized once, at the end.
    const points: DecimalBucket[] = Array.from({ length: n }, (_, i) => ({
      start: new Date(floorSince + i * stepMs).toISOString(),
      costAmount: ZERO,
      byAgent: new Map(),
      byModel: new Map()
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
    const [inRange, baselineRows] = await Promise.all([
      this.db.$queryRaw<
        Array<{ agentId: string; sessionId: string; at: Date; cumulativeCost: Prisma.Decimal; model: string | null }>
      >(Prisma.sql`
        SELECT sp."agentId", sp."sessionId", sp."at", sp."cumulativeCost", NULLIF(sp."model", '') AS model
        FROM "session_spend" sp
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE ${agentViewerSql(orgId, viewer)}
          AND sp."at" >= ${since}
          AND ${sessionScope ?? Prisma.sql`TRUE`}
        ORDER BY sp."at" ASC
      `),
      this.db.$queryRaw<Array<{ agentId: string; sessionId: string; cumulativeCost: Prisma.Decimal }>>(Prisma.sql`
        SELECT DISTINCT ON (sp."agentId", sp."sessionId")
               sp."agentId", sp."sessionId", sp."cumulativeCost"
        FROM "session_spend" sp
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE ${agentViewerSql(orgId, viewer)}
          AND sp."at" < ${since}
          AND ${sessionScope ?? Prisma.sql`TRUE`}
        ORDER BY sp."agentId", sp."sessionId", sp."at" DESC
      `)
    ])
    // Per-session running cumulative, seeded from the last pre-window report so the
    // first in-window delta counts only spend incurred inside the window.
    const prevCost = new Map<string, Prisma.Decimal>(
      baselineRows.map((r) => [r.agentId + SEP + r.sessionId, r.cumulativeCost])
    )
    const perAgentCost = new Map<string, Prisma.Decimal>()
    const perModelCost = new Map<string, Prisma.Decimal>()
    let totalCost = ZERO
    // `inRange` is globally at-ascending, so each session's rows are visited in
    // chronological order — exactly what the running diff needs.
    for (const row of inRange) {
      const skey = row.agentId + SEP + row.sessionId
      const delta = row.cumulativeCost.minus(prevCost.get(skey) ?? ZERO)
      prevCost.set(skey, row.cumulativeCost)
      totalCost = totalCost.plus(delta)
      perAgentCost.set(row.agentId, (perAgentCost.get(row.agentId) ?? ZERO).plus(delta))
      const modelKey = row.model ?? ''
      perModelCost.set(modelKey, (perModelCost.get(modelKey) ?? ZERO).plus(delta))
      const idx = Math.floor((row.at.getTime() - floorSince) / stepMs)
      if (idx >= 0 && idx < n) {
        const pt = points[idx]!
        pt.costAmount = pt.costAmount.plus(delta)
        if (!delta.isZero()) {
          pt.byAgent.set(row.agentId, (pt.byAgent.get(row.agentId) ?? ZERO).plus(delta))
          pt.byModel.set(modelKey, (pt.byModel.get(modelKey) ?? ZERO).plus(delta))
        }
      }
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
      costAmount: amount(perAgentCost.get(g.agentId) ?? ZERO)
    }))
    // Sort by token spend so the console's "top agents" ordering is stable.
    agents.sort((a, b) => b.totalTokens - a.totalTokens)

    const models: ModelUsageAggregate[] = modelGrouped.map((g) => ({
      model: g.model,
      sessions: Number(g.sessions),
      totalTokens: Number(g.totalTokens),
      inputTokens: Number(g.inputTokens),
      outputTokens: Number(g.outputTokens),
      thoughtTokens: Number(g.thoughtTokens),
      cachedReadTokens: Number(g.cachedReadTokens),
      cachedWriteTokens: Number(g.cachedWriteTokens),
      costAmount: amount(perModelCost.get(g.model ?? '') ?? ZERO)
    }))
    models.sort((a, b) => b.totalTokens - a.totalTokens)

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

    const series: SpendBucket[] = points.map((pt) => ({
      start: pt.start,
      costAmount: amount(pt.costAmount),
      byAgent: amounts(pt.byAgent),
      byModel: amounts(pt.byModel)
    }))

    return {
      totals: { ...totals, costAmount: amount(totalCost), costCurrency },
      agents,
      models,
      series: { bucket, points: series }
    }
  }
}
