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
import { countCheckpointRegression, countUsageAttributionDrift } from '../../observability/usage-ingest.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { sessionViewerSql } from './session-access-sql.js'

/** A bucket mid-accumulation: scaled-integer sums, serialized once at the end. */
interface ScaledBucket {
  start: string
  costAmount: bigint
  byAgent: Map<string, bigint>
  byModel: Map<string, bigint>
}

/** One `session_spend` row as the walk reads it. `visible` says whether the reading
 *  viewer may attribute it — always true for a credential that reads the org whole. */
interface SpendRow {
  agentId: string
  sessionId: string
  at: Date
  visible: boolean
  source: UsageSource
  model: string | null
  cumulativeTotalTokens: number
  cumulativeInputTokens: number
  cumulativeOutputTokens: number
  cumulativeThoughtTokens: number
  cumulativeCachedReadTokens: number
  cumulativeCachedWriteTokens: number
  cumulativeCost: string
}

/** A session's cumulative counters at one instant. Tokens are numbers (a workspace's
 *  totals stay far inside 2^53); cost is a scaled integer, because it is money. */
interface Counters {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  thoughtTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  cost: bigint
}

const ZERO_COUNTERS: Counters = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  cost: 0n
}

/** One grouping's accumulated deltas. `sessions` is a set so a session spanning many
 *  checkpoints counts once, however many reports it made. */
interface Rollup extends Counters {
  sessions: Set<string>
}

function countersOf(row: Omit<SpendRow, 'visible'>): Counters {
  return {
    totalTokens: row.cumulativeTotalTokens,
    inputTokens: row.cumulativeInputTokens,
    outputTokens: row.cumulativeOutputTokens,
    thoughtTokens: row.cumulativeThoughtTokens,
    cachedReadTokens: row.cumulativeCachedReadTokens,
    cachedWriteTokens: row.cumulativeCachedWriteTokens,
    cost: scaleAmount(row.cumulativeCost)
  }
}

function subtractCounters(current: Counters, previous: Counters): Counters {
  return {
    totalTokens: current.totalTokens - previous.totalTokens,
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    thoughtTokens: current.thoughtTokens - previous.thoughtTokens,
    cachedReadTokens: current.cachedReadTokens - previous.cachedReadTokens,
    cachedWriteTokens: current.cachedWriteTokens - previous.cachedWriteTokens,
    cost: current.cost - previous.cost
  }
}

function emptyRollup(): Rollup {
  return { ...ZERO_COUNTERS, sessions: new Set() }
}

function rollupOf<K>(by: Map<K, Rollup>, k: K): Rollup {
  const existing = by.get(k)
  if (existing) return existing
  const fresh = emptyRollup()
  by.set(k, fresh)
  return fresh
}

function addDelta(target: Rollup, delta: Counters, sessionKey: string): void {
  target.totalTokens += delta.totalTokens
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.thoughtTokens += delta.thoughtTokens
  target.cachedReadTokens += delta.cachedReadTokens
  target.cachedWriteTokens += delta.cachedWriteTokens
  target.cost += delta.cost
  target.sessions.add(sessionKey)
}

/** A rollup as the response carries it. */
function rollupDto(r: Rollup): Omit<AgentUsageAggregate, 'agentId'> {
  return {
    sessions: r.sessions.size,
    totalTokens: r.totalTokens,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    thoughtTokens: r.thoughtTokens,
    cachedReadTokens: r.cachedReadTokens,
    cachedWriteTokens: r.cachedWriteTokens,
    costAmount: unscaleAmount(r.cost)
  }
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
    // ── What the viewer predicates scope, and what they do NOT ──────────────────
    // They scope ATTRIBUTION, not the sums. An org's spend is a fact about the org, and
    // a total that silently omitted the rows no human may read is wrong in the direction
    // that costs someone money — the same argument the settlement credential already
    // rests on, and the org's own figure is anyway published to every member by the
    // billing ledger. What the viewer may not learn is WHOSE spend it was.
    //
    // So the predicates stop being a WHERE and become a SELECTed boolean: a row the
    // viewer may not attribute still lands in `totals` and in the ingress rollup, but is
    // folded into ONE id-less `unattributed` bucket instead of into its agent's row.
    //
    // That bucket is aggregated INDEPENDENTLY — it is a fifth grouping of the same set of
    // deltas, never `totals` minus the visible rows. The distinction is the whole point:
    // a subtraction is a plug figure that absorbs any attribution bug and leaves the page
    // adding up perfectly, while an independent sum turns `Σ agents + unattributed =
    // totals` into an invariant that a bug BREAKS, and that the check below catches.
    //
    // The SERIES stays viewer-scoped, splits and per-bucket total alike, so a bucket never
    // hands over withheld spend resolved in time.
    //
    // Be exact about what that is and is not worth, because the comfortable version is
    // wrong: it is NOT a security boundary. `from`/`to` are the caller's, bounded only by
    // a maximum span, so a member who wants the timeline can ask for consecutive narrow
    // windows — and split them again by `source` — and difference the residual out at
    // whatever resolution they choose. An accurate total over a caller-chosen window IS a
    // timeline; no scoping inside the response changes that, and no k-anonymity rule can,
    // because the residual is implied by subtraction whether or not it is sent.
    //
    // What the scoping does buy is that the timeline is never handed over incidentally —
    // it takes a deliberate scripted read rather than one glance at a chart, which is a
    // real difference between an accidental disclosure and an attack, and not much more
    // than that. Bounding it properly would mean a minimum window span (day resolution at
    // best, and the 24-hour view stops reconciling) or dropping accurate totals. Neither
    // is free, and the trade as it stands is recorded in session-visibility.md.
    //
    // The INGRESS rollup counts every row, unlike the other two, because `daemon` vs
    // `gateway` is not a resource identity — nobody is named by it — and keeping it whole
    // means `Σ sources = totals` for the settlement reader that lives off that line.
    //
    // One ingress or both. Scoping the WHOLE answer to a source is separate from all of
    // the above, and is what lets billing ask for gateway spend through this same route.
    const sourceScope = (alias: string) =>
      source ? Prisma.sql`AND ${Prisma.raw(`${alias}."source"`)} = ${source}::"UsageSource"` : Prisma.empty
    // A gateway-metered row's sessionId (a hash minted for the model credential) matches no
    // session_meta, so the viewer predicate's equality arms would silently drop it; an unlinked
    // row has no per-session content to protect, so it falls back to agent visibility alone.
    const viewerScope = sessionViewerSql(sessionViewer)
    const sessionScope = viewerScope ? Prisma.sql`(s."id" IS NULL OR ${viewerScope})` : null
    // `visible` is evaluated only over rows already inside the org, the window and the
    // source, so the residual means exactly one thing: "this viewer may not attribute
    // it". It is never a catch-all — a row that fails the `agent` JOIN outright still
    // drops out of every figure, as it did before, and hiding that in here would rebuild
    // the plug figure the independent sum exists to avoid.
    const visibleSql = Prisma.sql`(${agentViewerSql(orgId, viewer)}) AND (${sessionScope ?? Prisma.sql`TRUE`}) AS visible`

    // EVERY figure in this answer comes from the spend timeline inside `[from, to)`,
    // diffed against each session's last checkpoint before the window. Tokens too, not
    // just cost: summing the session's CURRENT snapshot instead made an already-closed
    // period keep changing — a session reporting again next week raised last month's
    // token total, and a model first used after the window appeared inside it. A period
    // is a statement about what happened during it, so it must be answerable from what
    // was recorded during it and never move again.
    //
    // It also makes the response agree with itself by construction: totals, agents,
    // models and sources are four groupings of ONE set of deltas, so they cannot drift
    // the way three independent SQL rollups did.
    const spendColumns = Prisma.sql`
             sp."cumulativeTotalTokens", sp."cumulativeInputTokens", sp."cumulativeOutputTokens",
             sp."cumulativeThoughtTokens", sp."cumulativeCachedReadTokens", sp."cumulativeCachedWriteTokens",
             sp."cumulativeCost"::text`
    const spendScope = Prisma.sql`
        FROM "session_spend" sp
        JOIN "agent" a ON a."id" = sp."agentId"
        LEFT JOIN "session_meta" s ON s."id" = sp."sessionId" AND s."agentId" = sp."agentId"
        WHERE a."orgId" = ${orgId}
          ${sourceScope('sp')}`

    const HOUR_MS = 60 * 60 * 1000
    const spanMs = to.getTime() - from.getTime()
    // The route refuses an over-wide window, so this is a guard for a direct caller
    // rather than a reachable path: the bucket count sizes an eager allocation, so it
    // must never be whatever arithmetic on two caller-supplied instants produces.
    // Throwing beats clamping — a silently truncated series is a wrong answer that
    // looks right.
    if (spanMs > MAX_USAGE_WINDOW_DAYS * 24 * HOUR_MS) {
      throw new Error(`usage window may span at most ${MAX_USAGE_WINDOW_DAYS} days`)
    }

    const [inRange, baselineRows, currencies] = await Promise.all([
      this.db.$queryRaw<SpendRow[]>(Prisma.sql`
        SELECT sp."agentId", sp."sessionId", sp."at", sp."source", NULLIF(sp."model", '') AS model,
               ${visibleSql},
        ${spendColumns}
        ${spendScope}
          AND sp."at" >= ${from}
          AND sp."at" < ${to}
        ORDER BY sp."at" ASC
      `),
      // The baseline is the session's state entering the window, per source, so the
      // first in-window delta counts only what the window itself consumed. It needs no
      // `visible` flag: it only seeds a running counter, and the delta it seeds is
      // attributed by the IN-RANGE row that consumes it.
      this.db.$queryRaw<Omit<SpendRow, 'visible'>[]>(Prisma.sql`
        SELECT DISTINCT ON (sp."agentId", sp."sessionId", sp."source")
               sp."agentId", sp."sessionId", sp."at", sp."source", NULLIF(sp."model", '') AS model,
        ${spendColumns}
        ${spendScope}
          AND sp."at" < ${from}
        ORDER BY sp."agentId", sp."sessionId", sp."source", sp."at" DESC
      `),
      // Currency lives on the snapshot, not the timeline. Scope it to the sessions this
      // window actually contains so a workspace's other currencies cannot label it.
      this.db.$queryRaw<Array<{ costCurrency: string }>>(Prisma.sql`
        SELECT DISTINCT u."costCurrency"
        FROM "session_usage" u
        JOIN "agent" a ON a."id" = u."agentId"
        WHERE a."orgId" = ${orgId}
          AND u."costCurrency" IS NOT NULL
          ${sourceScope('u')}
          AND EXISTS (
            SELECT 1 FROM "session_spend" w
            WHERE w."agentId" = u."agentId" AND w."sessionId" = u."sessionId"
              AND w."at" >= ${from} AND w."at" < ${to}
              ${sourceScope('w')}
          )
      `)
    ])

    // Bucket geometry: hourly for a window of two days or less, daily beyond. Buckets
    // align to the viewer's LOCAL day/hour: we shift into local time (subtract offMs),
    // floor there, shift back — so `start` is the UTC instant of a local boundary and
    // the client labels it in local tz. offMs is 0 ⇒ plain UTC. Geometry follows the
    // WINDOW, not the clock: a closed month returns that month's buckets.
    // ponytail: one current offset applied across the whole window — a DST change
    // mid-range misattributes the ~1h around the switch; acceptable for a spend chart,
    // pass an IANA tz + date_trunc if hour-exact local days ever matter.
    const offMs = tzOffsetMin * 60 * 1000
    const bucket: 'hour' | 'day' = spanMs <= 2 * 24 * HOUR_MS ? 'hour' : 'day'
    const stepMs = bucket === 'hour' ? HOUR_MS : 24 * HOUR_MS
    const floorSince = Math.floor((from.getTime() - offMs) / stepMs) * stepMs + offMs
    const n = Math.max(1, Math.ceil((to.getTime() - floorSince) / stepMs))
    const points: ScaledBucket[] = Array.from({ length: n }, (_, i) => ({
      start: new Date(floorSince + i * stepMs).toISOString(),
      costAmount: 0n,
      byAgent: new Map(),
      byModel: new Map()
    }))

    // Per-session running state, seeded from the pre-window checkpoint. `inRange` is
    // globally at-ascending, so each session's rows are visited chronologically —
    // exactly what the running diff needs. A replay contributes 0 (nothing changed) and
    // a downward correction contributes a negative delta that nets out, so the cards and
    // the chart always show the same numbers.
    const SEP = '\0'
    const key = (row: Omit<SpendRow, 'visible'>) => row.agentId + SEP + row.sessionId + SEP + row.source
    const previous = new Map<string, Counters>(baselineRows.map((row) => [key(row), countersOf(row)]))
    const totals = emptyRollup()
    const byAgent = new Map<string, Rollup>()
    const byModel = new Map<string, Rollup>()
    const bySource = new Map<UsageSource, Rollup>()
    // The fifth grouping. It stays empty whenever the caller may attribute everything,
    // which is every read that passes no viewer.
    const unattributed = emptyRollup()

    for (const row of inRange) {
      const skey = key(row)
      const current = countersOf(row)
      const delta = subtractCounters(current, previous.get(skey) ?? ZERO_COUNTERS)
      previous.set(skey, current)
      const modelKey = row.model ?? ''
      // The two attribution groupings and the residual are mutually exclusive, so this is
      // a branch and not two entries in the list: pointing both the agent arm and the
      // model arm at `unattributed` would add the same delta to it twice.
      const targets = row.visible
        ? [totals, rollupOf(byAgent, row.agentId), rollupOf(byModel, modelKey), rollupOf(bySource, row.source)]
        : [totals, unattributed, rollupOf(bySource, row.source)]
      for (const target of targets) addDelta(target, delta, skey)
      // Series: visible rows only, so no bucket resolves a restricted agent's spend in
      // time. Its per-bucket total is therefore the visible sum, NOT `totals` split up.
      if (!row.visible) continue
      const idx = Math.floor((row.at.getTime() - floorSince) / stepMs)
      if (idx >= 0 && idx < n) {
        const pt = points[idx]!
        pt.costAmount += delta.cost
        if (delta.cost !== 0n) {
          pt.byAgent.set(row.agentId, (pt.byAgent.get(row.agentId) ?? 0n) + delta.cost)
          pt.byModel.set(modelKey, (pt.byModel.get(modelKey) ?? 0n) + delta.cost)
        }
      }
    }

    // The invariant, CHECKED. `Σ agents + unattributed = totals` holds by construction —
    // one fold, one set of deltas, mutually exclusive targets — which is exactly why a
    // violation means the fold itself is broken rather than the data being odd. Every
    // quantity here is exact integer arithmetic (tokens are ints well inside 2^53, cost is
    // a scaled bigint), so this is an equality and not a tolerance.
    //
    // Throwing beats serving it, for the same reason the window guard above throws: the
    // alternative is a money figure that is wrong and looks right, on a page whose whole
    // job is to be reconciled against an invoice. The counter is incremented first so the
    // failure is observable even though the request does not survive it.
    const attributedCost = [...byAgent.values()].reduce((sum, r) => sum + r.cost, 0n) + unattributed.cost
    const attributedTokens = [...byAgent.values()].reduce((sum, r) => sum + r.totalTokens, 0) + unattributed.totalTokens
    const attributedSessions =
      [...byAgent.values()].reduce((sum, r) => sum + r.sessions.size, 0) + unattributed.sessions.size
    if (
      attributedCost !== totals.cost ||
      attributedTokens !== totals.totalTokens ||
      attributedSessions !== totals.sessions.size
    ) {
      countUsageAttributionDrift()
      throw new Error(
        'usage aggregate failed its attribution invariant: the per-agent rollup plus the unattributed residual does not equal the totals'
      )
    }

    const agents: AgentUsageAggregate[] = [...byAgent].map(([agentId, r]) => ({ agentId, ...rollupDto(r) }))
    // Sort by token spend so the console's "top agents" ordering is stable.
    agents.sort((left, right) => right.totalTokens - left.totalTokens)
    const models: ModelUsageAggregate[] = [...byModel].map(([model, r]) => ({ model: model || null, ...rollupDto(r) }))
    models.sort((left, right) => right.totalTokens - left.totalTokens)
    const sources: SourceUsageAggregate[] = [...bySource].map(([src, r]) => ({ source: src, ...rollupDto(r) }))
    sources.sort((left, right) => right.totalTokens - left.totalTokens)

    // Cost currency for the window: the single distinct currency reported. `null` when
    // none or mixed — amounts are summed as-is, so a mixed-currency workspace surfaces
    // an unlabeled total (a known limitation until per-currency rollups).
    const costCurrency = currencies.length === 1 ? currencies[0]!.costCurrency : null

    const series: SpendBucket[] = points.map((pt) => ({
      start: pt.start,
      costAmount: unscaleAmount(pt.costAmount),
      byAgent: amounts(pt.byAgent),
      byModel: amounts(pt.byModel)
    }))

    const overall = rollupDto(totals)
    // Omitted rather than zeroed when the viewer could attribute everything: a reader
    // must be able to tell "nothing was hidden" from "something was hidden and cost 0".
    const residual = unattributed.sessions.size > 0 ? rollupDto(unattributed) : undefined
    return {
      totals: {
        sessions: overall.sessions,
        totalTokens: overall.totalTokens,
        costAmount: overall.costAmount,
        costCurrency
      },
      agents,
      models,
      sources,
      ...(residual ? { unattributed: residual } : {}),
      series: { bucket, points: series }
    }
  }
}
