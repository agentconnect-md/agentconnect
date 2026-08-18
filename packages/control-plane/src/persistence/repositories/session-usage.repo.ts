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
 * COST is the exception to all of that: it is `NUMERIC(38,18)`, it is read out as TEXT,
 * and every diff and sum below runs on integers scaled by that column's scale. Billing
 * reads these aggregates, so no step may round — not through a float, and not through
 * `Prisma.Decimal` either, whose arithmetic rounds to 20 significant digits and would
 * turn an exact `123.123456789012345678` into `123.12345678901234568` on the first
 * subtraction. Scaled `bigint` has no precision setting to get wrong.
 */
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { Prisma } from '../../generated/prisma/client.js'
import { type DecimalAmount, scaleAmount, unscaleAmount } from '@agentconnect.md/protocol'
import { MAX_USAGE_WINDOW_DAYS } from '../ports.js'
import type {
  SessionUsageRepo,
  SessionUsageInput,
  SessionUsageCounts,
  UsageAggregate,
  AgentUsageAggregate,
  ModelUsageAggregate,
  SpendBucket,
  SourceUsageAggregate,
  UsageWindow,
  UsageSource,
  ViewCtx,
  SessionFilterQuery
} from '../ports.js'
import { countCheckpointRegression } from '../../observability/usage-ingest.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { sessionViewerSql } from './session-access-sql.js'

/** A bucket mid-accumulation: scaled-integer sums, serialized once at the end. */
interface ScaledBucket {
  start: string
  costAmount: bigint
  byAgent: Map<string, bigint>
  byModel: Map<string, bigint>
}

/** Serialize a keyed scaled-integer map for the response. */
function amounts(by: Map<string, bigint>): Record<string, DecimalAmount> {
  return Object.fromEntries([...by].map(([key, value]) => [key, unscaleAmount(value)]))
}

/** "This report does not move any counter backwards", for one table's column names.
 *  The snapshot and the checkpoint carry the same counters under different names, and
 *  they MUST agree on whether a report is accepted: gating only one of them lets a
 *  rejected report half-land, leaving `get()` and the aggregate reading two different
 *  stories about the same session. */
function advancesSql(table: string, columns: Readonly<Record<string, string>>): Prisma.Sql {
  const stored = (column: string) => Prisma.raw(`"${table}"."${column}"`)
  const incoming = (column: string) => Prisma.raw(`EXCLUDED."${column}"`)
  return Prisma.join(
    Object.values(columns).map((column) => Prisma.sql`${stored(column)} <= ${incoming(column)}`),
    ' AND '
  )
}

/** The cumulative counters, per table. Same quantities, different column names. */
const SNAPSHOT_COUNTERS = {
  total: 'totalTokens',
  input: 'inputTokens',
  output: 'outputTokens',
  thought: 'thoughtTokens',
  cachedRead: 'cachedReadTokens',
  cachedWrite: 'cachedWriteTokens',
  cost: 'costAmount'
} as const

const CHECKPOINT_COUNTERS = {
  total: 'cumulativeTotalTokens',
  input: 'cumulativeInputTokens',
  output: 'cumulativeOutputTokens',
  thought: 'cumulativeThoughtTokens',
  cachedRead: 'cumulativeCachedReadTokens',
  cachedWrite: 'cumulativeCachedWriteTokens',
  cost: 'cumulativeCost'
} as const

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

  /** One report, one acceptance decision, both tables — atomically.
   *
   *  The two upserts share a transaction because matching predicates alone are not one
   *  decision: as separate autocommit statements, two concurrent reports for the same
   *  instant whose counters are INCOMPARABLE (A ahead on tokens, B ahead on cost) can
   *  win one table each, and the fences then reject whichever report would repair the
   *  split — the tables never converge, not even on replay. Inside a transaction the
   *  first writer holds the snapshot row until commit, so the second evaluates its
   *  fence against a committed predecessor and both tables agree on the same winner.
   *  `withAmbientTx` composes under a caller's transaction rather than nesting. */
  async record(input: SessionUsageInput): Promise<void> {
    await withAmbientTx(this.db, (tx) => this.write(tx, input))
  }

  private async write(db: Prisma.TransactionClient, input: SessionUsageInput): Promise<void> {
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
    // an idempotent no-op write. At the SAME instant it applies exactly the rule the
    // checkpoint applies below — a report the checkpoint refuses must not half-land
    // here, or `get()` and the aggregate would tell two stories about one session.
    await db.$executeRaw(Prisma.sql`
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
      WHERE "session_usage"."lastActivityAt" < EXCLUDED."lastActivityAt"
         OR ("session_usage"."lastActivityAt" = EXCLUDED."lastActivityAt"
             AND ${advancesSql('session_usage', SNAPSHOT_COUNTERS)})
    `)
    // Usage timeline: each report carries cumulative counters plus the model for
    // the interval that just ended. Readers diff consecutive rows, so model
    // switches retain their own deltas while duplicate deliveries stay idempotent.
    // A late report DOES write its own checkpoint — it belongs at its own `at`.
    //
    // A checkpoint only moves FORWARD. The trailing predicate ignores a retry whose
    // cumulative is lower than what is already stored at that instant: re-sending the
    // same numbers still lands (an idempotent rewrite), a higher cumulative advances
    // the row, and a straggler overtaken by a newer delivery is dropped instead of
    // rolling spend back — which would make the next window's diff negative and bill
    // the difference twice once the real value returned. A report is accepted or
    // ignored WHOLE: mixing a higher cost from one delivery with a lower token count
    // from another would synthesize a checkpoint nobody reported, and readers
    // attribute the interval's spend to this row's model.
    const [merge] = await db.$queryRaw<Array<{ owned: number; applied: number }>>(Prisma.sql`
      WITH owner AS (SELECT a."id" ${owner}),
      merged AS (
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
      FROM owner
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
      WHERE ${advancesSql('session_spend', CHECKPOINT_COUNTERS)}
      RETURNING 1
      )
      SELECT (SELECT COUNT(*)::int FROM owner) AS owned,
             (SELECT COUNT(*)::int FROM merged) AS applied
    `)
    // Nothing written for an agent that DOES exist ⇒ the fence above rejected it.
    // An unowned report is the other zero, and is a drop we already accept silently.
    if (merge && merge.owned > 0 && merge.applied === 0) countCheckpointRegression(input.source)
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
    window: UsageWindow,
    viewer?: ViewCtx,
    tzOffsetMin = 0,
    sessionViewer?: SessionFilterQuery['viewer'],
    source?: UsageSource
  ): Promise<UsageAggregate> {
    const { from, to } = window
    // Derived visibility: usage rows inherit their agent's visibility, so scope
    // through the `agent` relation (`agentViewerSql`). A restricted agent the caller
    // cannot see drops out of BOTH the per-agent breakdown and the totals.
    // Organization roles never widen that resource-level visibility.
    // One ingress or both. Scoping the WHOLE answer (totals, breakdowns, series) is
    // what lets billing ask for gateway spend alone through the console's own route
    // instead of a private one.
    const sourceScope = (alias: string) =>
      source ? Prisma.sql`AND ${Prisma.raw(`${alias}."source"`)} = ${source}::"UsageSource"` : Prisma.empty
    const sessionScope = sessionViewerSql(sessionViewer)
    // WHICH SESSIONS the window contains — one definition, used by every snapshot
    // rollup, so a response cannot contradict itself.
    //
    // A checkpoint inside the window is the primary test, NOT where the session's
    // latest report happens to sit: a session that spent inside a closed window and
    // reported again afterwards belongs to that window, and its in-window delta reaches
    // the total regardless — so excluding it from the rollups produced a non-zero total
    // over empty breakdowns.
    //
    // The snapshot's own instant is kept as a second test for a row with no checkpoint
    // at all. `record` writes both in one transaction, so that pair is only reachable
    // for a row written outside it (a fixture, an import); counting it keeps such a row
    // visible in the token rollups instead of silently vanishing. The union stays
    // coherent because cost is only ever attributed from in-window CHECKPOINTS: every
    // session that contributes cost is in this set, and one that does not contributes 0.
    const inWindow = Prisma.sql`(
          EXISTS (
            SELECT 1 FROM "session_spend" w
            WHERE w."agentId" = u."agentId" AND w."sessionId" = u."sessionId"
              AND w."at" >= ${from} AND w."at" < ${to}
              ${sourceScope('w')}
          )
          OR (u."lastActivityAt" >= ${from} AND u."lastActivityAt" < ${to})
        )`
    // The snapshot rollups differ only in what they group by, so they share their
    // columns and their eligibility instead of restating both three times.
    const tokenColumns = Prisma.sql`
                 COUNT(*)::bigint AS sessions,
                 COALESCE(SUM(u."totalTokens"), 0)::bigint AS "totalTokens",
                 COALESCE(SUM(u."inputTokens"), 0)::bigint AS "inputTokens",
                 COALESCE(SUM(u."outputTokens"), 0)::bigint AS "outputTokens",
                 COALESCE(SUM(u."thoughtTokens"), 0)::bigint AS "thoughtTokens",
                 COALESCE(SUM(u."cachedReadTokens"), 0)::bigint AS "cachedReadTokens",
                 COALESCE(SUM(u."cachedWriteTokens"), 0)::bigint AS "cachedWriteTokens"`
    // `session_meta` is LEFT joined so a usage row with no meta row still counts when no
    // session predicate applies; with one, the predicate rejects the NULL side, which is
    // the same answer the scoped path gave when it inner-joined.
    const snapshotScope = Prisma.sql`
          FROM "session_usage" u
          JOIN "agent" a ON a."id" = u."agentId"
          LEFT JOIN "session_meta" s ON s."id" = u."sessionId" AND s."agentId" = u."agentId"
          WHERE ${agentViewerSql(orgId, viewer)}
            AND ${inWindow}
            ${sourceScope('u')}
            AND ${sessionScope ?? Prisma.sql`TRUE`}`
    // Tokens + session counts come from the lifetime snapshot (tokens aren't
    // time-attributed). Cost is deliberately NOT summed here — every range-scoped
    // cost figure (the total, each agent's spend, and the chart) is derived from
    // the spend timeline below, so the cards and the chart can never disagree.
    const grouped = await this.db.$queryRaw<
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
          SELECT u."agentId", ${tokenColumns}
          ${snapshotScope}
          GROUP BY u."agentId"
        `)

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
          AND ${inWindow}
          ${sourceScope('sp')}
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
    // Geometry follows the WINDOW, not the clock: a closed month asked for after the
    // fact must return that month's buckets, not buckets running up to today.
    const spanMs = to.getTime() - from.getTime()
    const bucket: 'hour' | 'day' = spanMs <= 2 * 24 * HOUR_MS ? 'hour' : 'day'
    const stepMs = bucket === 'hour' ? HOUR_MS : 24 * HOUR_MS
    // Floor `from` to the start of its local bucket, expressed as a UTC instant.
    const floorSince = Math.floor((from.getTime() - offMs) / stepMs) * stepMs + offMs
    // The route refuses an over-wide window, so this is a guard for a direct caller
    // rather than a reachable path: `n` sizes an eager allocation, so it must never be
    // whatever arithmetic on two caller-supplied instants happens to produce. Throwing
    // beats clamping — a silently truncated series is a wrong answer that looks right.
    if (spanMs > MAX_USAGE_WINDOW_DAYS * 24 * HOUR_MS) {
      throw new Error(`usage window may span at most ${MAX_USAGE_WINDOW_DAYS} days`)
    }
    const n = Math.max(1, Math.ceil((to.getTime() - floorSince) / stepMs))
    // Buckets accumulate as scaled integers and are serialized once, at the end.
    const points: ScaledBucket[] = Array.from({ length: n }, (_, i) => ({
      start: new Date(floorSince + i * stepMs).toISOString(),
      costAmount: 0n,
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
        Array<{
          agentId: string
          sessionId: string
          at: Date
          cumulativeCost: string
          model: string | null
          source: UsageSource
        }>
      >(Prisma.sql`
        SELECT sp."agentId", sp."sessionId", sp."at", sp."cumulativeCost"::text,
               NULLIF(sp."model", '') AS model, sp."source"
        FROM "session_spend" sp
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE ${agentViewerSql(orgId, viewer)}
          AND sp."at" >= ${from}
          AND sp."at" < ${to}
          ${sourceScope('sp')}
          AND ${sessionScope ?? Prisma.sql`TRUE`}
        ORDER BY sp."at" ASC
      `),
      this.db.$queryRaw<Array<{ agentId: string; sessionId: string; source: UsageSource; cumulativeCost: string }>>(
        Prisma.sql`
        SELECT DISTINCT ON (sp."agentId", sp."sessionId", sp."source")
               sp."agentId", sp."sessionId", sp."source", sp."cumulativeCost"::text
        FROM "session_spend" sp
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE ${agentViewerSql(orgId, viewer)}
          AND sp."at" < ${from}
          ${sourceScope('sp')}
          AND ${sessionScope ?? Prisma.sql`TRUE`}
        ORDER BY sp."agentId", sp."sessionId", sp."source", sp."at" DESC
      `
      )
    ])
    // Per-session running cumulative, seeded from the last pre-window report so the
    // first in-window delta counts only spend incurred inside the window.
    const prevCost = new Map<string, bigint>(
      baselineRows.map((r) => [r.agentId + SEP + r.sessionId + SEP + r.source, scaleAmount(r.cumulativeCost)])
    )
    const perAgentCost = new Map<string, bigint>()
    const perModelCost = new Map<string, bigint>()
    const perSourceCost = new Map<string, bigint>()
    let totalCost = 0n
    // `inRange` is globally at-ascending, so each session's rows are visited in
    // chronological order — exactly what the running diff needs.
    for (const row of inRange) {
      const skey = row.agentId + SEP + row.sessionId + SEP + row.source
      const cumulative = scaleAmount(row.cumulativeCost)
      const delta = cumulative - (prevCost.get(skey) ?? 0n)
      prevCost.set(skey, cumulative)
      totalCost += delta
      perAgentCost.set(row.agentId, (perAgentCost.get(row.agentId) ?? 0n) + delta)
      const modelKey = row.model ?? ''
      perModelCost.set(modelKey, (perModelCost.get(modelKey) ?? 0n) + delta)
      perSourceCost.set(row.source, (perSourceCost.get(row.source) ?? 0n) + delta)
      const idx = Math.floor((row.at.getTime() - floorSince) / stepMs)
      if (idx >= 0 && idx < n) {
        const pt = points[idx]!
        pt.costAmount += delta
        if (delta !== 0n) {
          pt.byAgent.set(row.agentId, (pt.byAgent.get(row.agentId) ?? 0n) + delta)
          pt.byModel.set(modelKey, (pt.byModel.get(modelKey) ?? 0n) + delta)
        }
      }
    }

    // Per-ingress tokens/sessions, from the same snapshot rows the agent rollup uses,
    // so `sources` and `agents` add up to the same totals.
    const sourceGrouped = await this.db.$queryRaw<
      Array<{
        source: UsageSource
        sessions: bigint
        totalTokens: bigint
        inputTokens: bigint
        outputTokens: bigint
        thoughtTokens: bigint
        cachedReadTokens: bigint
        cachedWriteTokens: bigint
      }>
    >(Prisma.sql`
          SELECT u."source", ${tokenColumns}
          ${snapshotScope}
          GROUP BY u."source"
        `)

    const agents: AgentUsageAggregate[] = grouped.map((g) => ({
      agentId: g.agentId,
      sessions: Number(g.sessions),
      totalTokens: Number(g.totalTokens),
      inputTokens: Number(g.inputTokens),
      outputTokens: Number(g.outputTokens),
      thoughtTokens: Number(g.thoughtTokens),
      cachedReadTokens: Number(g.cachedReadTokens),
      cachedWriteTokens: Number(g.cachedWriteTokens),
      costAmount: unscaleAmount(perAgentCost.get(g.agentId) ?? 0n)
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
      costAmount: unscaleAmount(perModelCost.get(g.model ?? '') ?? 0n)
    }))
    models.sort((a, b) => b.totalTokens - a.totalTokens)

    const sources: SourceUsageAggregate[] = sourceGrouped.map((g) => ({
      source: g.source,
      sessions: Number(g.sessions),
      totalTokens: Number(g.totalTokens),
      inputTokens: Number(g.inputTokens),
      outputTokens: Number(g.outputTokens),
      thoughtTokens: Number(g.thoughtTokens),
      cachedReadTokens: Number(g.cachedReadTokens),
      cachedWriteTokens: Number(g.cachedWriteTokens),
      costAmount: unscaleAmount(perSourceCost.get(g.source) ?? 0n)
    }))
    sources.sort((a, b) => b.totalTokens - a.totalTokens)

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
    const currencies = await this.db.$queryRaw<Array<{ costCurrency: string }>>(Prisma.sql`
          SELECT DISTINCT u."costCurrency"
          ${snapshotScope}
            AND u."costCurrency" IS NOT NULL
        `)
    const costCurrency = currencies.length === 1 ? currencies[0]!.costCurrency : null

    const series: SpendBucket[] = points.map((pt) => ({
      start: pt.start,
      costAmount: unscaleAmount(pt.costAmount),
      byAgent: amounts(pt.byAgent),
      byModel: amounts(pt.byModel)
    }))

    return {
      totals: { ...totals, costAmount: unscaleAmount(totalCost), costCurrency },
      agents,
      models,
      sources,
      series: { bucket, points: series }
    }
  }
}
