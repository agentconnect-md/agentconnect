/**
 * Usage dashboard end-to-end (WS `usage/report` EVT → persist → `GET /usage`).
 *
 * Two halves over the shared Testcontainers Postgres:
 *  - the `usage/report` handler persists a session's cumulative usage (latest-wins
 *    upsert on `(agentId, sessionId)`), a fire-and-forget EVT with no reply;
 *  - `GET /usage?from=…&to=…` sums the persisted store by agent over the window,
 *    excluding sessions whose last activity falls outside the range.
 */
import { describe, it, expect, vi } from 'vitest'
import { sumAmounts } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgSessionUsageRepo } from '../../src/persistence/repositories/session-usage.repo.js'
import { AgentId } from '../../src/domain/ids.js'

/** Sum the series' decimal-string amounts exactly — the same primitive the aggregate
 *  itself adds with, so the test cannot drift where the implementation does not. */
function sum(points: Array<{ costAmount: string }>): string {
  return sumAmounts(points.map((p) => p.costAmount))
}

/** The window a console preset resolves to, so these tests read like the client that
 *  sends them: the route itself has no notion of `d1`/`d30`, only `[from, to)`. */
function preset(range: 'd1' | 'd7' | 'd30' | 'd90', extra: Record<string, string> = {}): string {
  const days = { d1: 1, d7: 7, d30: 30, d90: 90 }[range]
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...extra }).toString()
}

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AUTH_ID = '44444444-4444-4444-8444-444444444444'
const REG_ID = '55555555-5555-4555-8555-555555555555'
const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'
/** A user who is NOT the reader, for sharing a restricted agent away from them. */
const SOMEONE_ELSE = '99999999-9999-4999-8999-999999999999'
const DAY_MS = 24 * 60 * 60 * 1000

async function seedVisibleSession(
  agentId: string,
  sessionId: string,
  lastActivityAt: Date,
  model?: string
): Promise<void> {
  await seedSessionMeta(prisma, sessionId, agentId, { lastActivityAt, ...(model ? { model } : {}) })
}

function authPayload(token: string) {
  return { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }
}
function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [] }
  }
}
async function connectReady(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { stub } = h.connect()
  stub.inject('auth', authPayload(token), { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject('register', registerPayload(), { id: REG_ID })
  await stub.expectFrame('register/ok')
  return { stub }
}

describe('usage/report handler — persists per-session token usage', () => {
  it('upserts the session usage; re-sending the cumulative snapshot is latest-wins (not additive)', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })

    stub.inject('usage/report', {
      sessionId: 'acp-sess-1',
      agentId: AGENT_A,
      platform: 'slack',
      channel: '#deploys',
      observedModel: 'claude-sonnet-4-5',
      lastActivityAt: new Date().toISOString(),
      usage: { totalTokens: 4820, inputTokens: 3600, outputTokens: 1220, cachedReadTokens: 512, costAmount: 0.41 }
    })

    // Fire-and-forget EVT — poll for the persisted rows. The spend sample is a SECOND
    // upsert, so waiting only on the counters can read the gap between them.
    const key = { agentId_sessionId: { agentId: AGENT_A, sessionId: 'acp-sess-1' } }
    await vi.waitFor(async () => {
      expect(await prisma.sessionUsage.findUnique({ where: key })).not.toBeNull()
      expect(
        await prisma.sessionSpend.findFirst({ where: { agentId: AGENT_A, sessionId: 'acp-sess-1' } })
      ).not.toBeNull()
    })
    let row = await prisma.sessionUsage.findUnique({ where: key })
    expect(row!.totalTokens).toBe(4820)
    expect(row!.inputTokens).toBe(3600)
    expect(row!.cachedReadTokens).toBe(512)
    expect(row!.costAmount.toFixed(2)).toBe('0.41')
    // The source is stamped from the authenticated adapter, not the payload.
    expect(row!.source).toBe('daemon')
    expect(await prisma.sessionSpend.findFirst({ where: { agentId: AGENT_A, sessionId: 'acp-sess-1' } })).toMatchObject(
      { model: 'claude-sonnet-4-5', cumulativeTotalTokens: 4820, source: 'daemon' }
    )

    // A later turn reports the NEW cumulative total → overwrite, never sum.
    stub.inject('usage/report', {
      sessionId: 'acp-sess-1',
      agentId: AGENT_A,
      lastActivityAt: new Date().toISOString(),
      usage: { totalTokens: 9000, inputTokens: 6800, outputTokens: 2200, costAmount: 0.82 }
    })
    await vi.waitFor(async () => {
      expect((await prisma.sessionUsage.findUnique({ where: key }))?.totalTokens).toBe(9000)
    })
    row = await prisma.sessionUsage.findUnique({ where: key })
    expect(row!.totalTokens).toBe(9000) // replaced, not 4820 + 9000
    expect(row!.outputTokens).toBe(2200)
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('splits a session that spans two buckets into a per-bucket spend ledger', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })

    const now = new Date()
    const yesterday = new Date(now.getTime() - DAY_MS)
    const where = { agentId: AGENT_A, sessionId: 'span' }
    await seedVisibleSession(AGENT_A, 'span', now)

    // Day 1: cumulative $1.
    stub.inject('usage/report', {
      sessionId: 'span',
      agentId: AGENT_A,
      lastActivityAt: yesterday.toISOString(),
      usage: { totalTokens: 100, costAmount: 1, costCurrency: 'USD' }
    })
    await vi.waitFor(async () => expect(await prisma.sessionSpend.count({ where })).toBe(1))

    // Day 2, SAME session: cumulative $2 → a $1 delta appended, not a rewrite of
    // the snapshot's single row into today's bucket.
    stub.inject('usage/report', {
      sessionId: 'span',
      agentId: AGENT_A,
      lastActivityAt: now.toISOString(),
      usage: { totalTokens: 200, costAmount: 2, costCurrency: 'USD' }
    })
    await vi.waitFor(async () => expect(await prisma.sessionSpend.count({ where })).toBe(2))

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d30')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { series: { points: { costAmount: string }[] } }
      const points = body.series.points
      // The regression: $1 stays in yesterday's bucket and $1 in today's. The old
      // latest-wins snapshot would show $0 yesterday and the full $2 today.
      expect(points.at(-2)!.costAmount).toBe('1')
      expect(points.at(-1)!.costAmount).toBe('1')
      expect(sum(points)).toBe('2')
    } finally {
      await close()
    }
  })

  it('attributes cumulative deltas across mid-session model switches', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    await seedAgent(prisma, AGENT_A, { daemonId: DAEMON })
    const now = Date.now()
    await seedVisibleSession(AGENT_A, 'switching', new Date(now - 60_000), 'latest-metadata-is-not-the-ledger')

    const reports = [
      { minutes: 3, observedModel: 'model-a' as string | null, totalTokens: 100, costAmount: 1 },
      { minutes: 2, observedModel: 'model-b' as string | null, totalTokens: 250, costAmount: 2.5 },
      { minutes: 1, observedModel: null, totalTokens: 300, costAmount: 3 }
    ]
    for (const [index, report] of reports.entries()) {
      stub.inject('usage/report', {
        sessionId: 'switching',
        agentId: AGENT_A,
        observedModel: report.observedModel,
        lastActivityAt: new Date(now - report.minutes * 60_000).toISOString(),
        usage: { totalTokens: report.totalTokens, costAmount: report.costAmount, costCurrency: 'USD' }
      })
      await vi.waitFor(async () => {
        expect(await prisma.sessionSpend.count({ where: { agentId: AGENT_A, sessionId: 'switching' } })).toBe(index + 1)
      })
    }

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const models = (
        res.json() as {
          models: Array<{ model: string | null; sessions: number; totalTokens: number; costAmount: string }>
        }
      ).models
      expect(models).toEqual([
        {
          model: 'model-b',
          sessions: 1,
          totalTokens: 150,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          costAmount: '1.5'
        },
        {
          model: 'model-a',
          sessions: 1,
          totalTokens: 100,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          costAmount: '1'
        },
        {
          model: null,
          sessions: 1,
          totalTokens: 50,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          costAmount: '0.5'
        }
      ])
    } finally {
      await close()
    }
  })

  it('drops usage for an agent not placed on the reporting daemon', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    await seedAgent(prisma, AGENT_B)
    const recordUsage = vi.spyOn(h.deps.usageWriter, 'record')
    const beginMutation = h.deps.agentMutations.tryBeginMutation.bind(h.deps.agentMutations)
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.spyOn(h.deps.agentMutations, 'tryBeginMutation').mockImplementation((agentIds) => {
      const release = beginMutation(agentIds)
      if (!release) return null
      return () => {
        release()
        finish()
      }
    })

    stub.inject('usage/report', {
      sessionId: 'foreign-session',
      agentId: AGENT_B,
      lastActivityAt: new Date().toISOString(),
      usage: { totalTokens: 1234 }
    })

    await finished
    expect(recordUsage).not.toHaveBeenCalled()
    expect(
      await prisma.sessionUsage.findUnique({
        where: { agentId_sessionId: { agentId: AGENT_B, sessionId: 'foreign-session' } }
      })
    ).toBeNull()
  })
})

describe('GET /usage — aggregates the persisted usage store by agent over a range', () => {
  it('sums tokens/cost + counts sessions per agent, and excludes rows outside the window', async () => {
    await seedAgent(prisma, AGENT_A)
    await seedAgent(prisma, AGENT_B)
    const now = new Date()
    // A d30 series buckets by DAY on the requested tz's boundary, which defaults to
    // UTC — and the assertions below require all three rows in the FINAL bucket. A
    // naive "N minutes ago" silently crosses into yesterday's bucket whenever the suite
    // runs within N minutes of UTC midnight, so clamp the offset to the time actually
    // elapsed since that boundary. (Everything stays comfortably inside the 30-day
    // window either way, so the totals and the tz-shift sums are unaffected.)
    const sinceUtcMidnight = now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const recent = (mins: number) => new Date(now.getTime() - Math.min(mins * 60_000, sinceUtcMidnight))

    await Promise.all([
      seedVisibleSession(AGENT_A, 'a1', recent(10), 'claude-sonnet-4-5'),
      seedVisibleSession(AGENT_A, 'a2', recent(20), 'claude-sonnet-4-5'),
      seedVisibleSession(AGENT_A, 'a-old', new Date(now.getTime() - 100 * DAY_MS), 'claude-opus-4-1'),
      seedVisibleSession(AGENT_B, 'b1', recent(30), 'gpt-5.6')
    ])

    // Agent A: two in-range sessions + one stale (100 days old, excluded from d30/d90).
    await prisma.sessionUsage.createMany({
      data: [
        {
          agentId: AGENT_A,
          sessionId: 'a1',
          totalTokens: 1000,
          costAmount: 0.1,
          costCurrency: 'USD',
          lastActivityAt: recent(10)
        },
        {
          agentId: AGENT_A,
          sessionId: 'a2',
          totalTokens: 2000,
          costAmount: 0.2,
          costCurrency: 'USD',
          lastActivityAt: recent(20)
        },
        {
          agentId: AGENT_A,
          sessionId: 'a-old',
          totalTokens: 9999,
          costAmount: 9.9,
          lastActivityAt: new Date(now.getTime() - 100 * DAY_MS)
        },
        // Agent B: one in-range session.
        {
          agentId: AGENT_B,
          sessionId: 'b1',
          totalTokens: 500,
          costAmount: 0.05,
          costCurrency: 'USD',
          lastActivityAt: recent(30)
        }
      ]
    })
    // Cost and model rollups derive from the cumulative timeline, not current
    // session metadata. Each row is a single-report session, so its cumulative
    // token/cost values belong entirely to the observed model.
    await prisma.sessionSpend.createMany({
      data: [
        {
          agentId: AGENT_A,
          sessionId: 'a1',
          model: 'claude-sonnet-4-5',
          cumulativeTotalTokens: 1000,
          cumulativeCost: 0.1,
          at: recent(10)
        },
        {
          agentId: AGENT_A,
          sessionId: 'a2',
          model: 'claude-sonnet-4-5',
          cumulativeTotalTokens: 2000,
          cumulativeCost: 0.2,
          at: recent(20)
        },
        {
          agentId: AGENT_A,
          sessionId: 'a-old',
          model: 'claude-opus-4-1',
          cumulativeTotalTokens: 9999,
          cumulativeCost: 9.9,
          at: new Date(now.getTime() - 100 * DAY_MS)
        },
        {
          agentId: AGENT_B,
          sessionId: 'b1',
          model: 'gpt-5.6',
          cumulativeTotalTokens: 500,
          cumulativeCost: 0.05,
          at: recent(30)
        }
      ]
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d30')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        from: string
        to: string
        totals: { sessions: number; totalTokens: number; costAmount: string; costCurrency: string | null }
        agents: { agentId: string; sessions: number; totalTokens: number; costAmount: string }[]
        models: { model: string | null; sessions: number; totalTokens: number; costAmount: string }[]
        series: { bucket: 'hour' | 'day'; points: { start: string; costAmount: string }[] }
      }

      expect(Date.parse(body.to) - Date.parse(body.from)).toBe(30 * DAY_MS)

      // Spend-over-time series: d30 buckets daily; the three in-range sessions
      // (10/20/30 min ago) all land in the final (today) bucket, and the stale
      // 100-day row is out of window → excluded. So the series sums to 0.35.
      expect(body.series.bucket).toBe('day')
      expect(body.series.points.length).toBeGreaterThanOrEqual(30)
      expect(sum(body.series.points)).toBe('0.35')
      expect(body.series.points.at(-1)!.costAmount).toBe('0.35')

      // A local-tz offset only shifts bucket boundaries — it must never drop or
      // double-count cost. Across extreme offsets the series still sums to 0.35.
      for (const tz of [-720, 780]) {
        const r = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d30', { tz: String(tz) })}` })
        expect(sum((r.json() as typeof body).series.points)).toBe('0.35')
      }
      // Stale a-old row excluded: 3 in-range sessions, 3500 tokens.
      expect(body.totals.sessions).toBe(3)
      expect(body.totals.totalTokens).toBe(3500)
      expect(body.totals.costAmount).toBe('0.35')
      // Single distinct non-null currency across the range → surfaced (the stale
      // row has no currency and is out of window anyway).
      expect(body.totals.costCurrency).toBe('USD')

      // Sorted by token spend desc → agent A first.
      const a = body.agents.find((x) => x.agentId === AGENT_A)!
      const b = body.agents.find((x) => x.agentId === AGENT_B)!
      expect(a.sessions).toBe(2)
      expect(a.totalTokens).toBe(3000)
      expect(b.sessions).toBe(1)
      expect(b.totalTokens).toBe(500)
      expect(body.agents[0]!.agentId).toBe(AGENT_A)

      // The per-report execution ledger drives Analytics; the stale Opus row
      // stays outside d30 regardless of current session metadata.
      expect(body.models.map(({ model, sessions, totalTokens }) => ({ model, sessions, totalTokens }))).toEqual([
        { model: 'claude-sonnet-4-5', sessions: 2, totalTokens: 3000 },
        { model: 'gpt-5.6', sessions: 1, totalTokens: 500 }
      ])
      expect(body.models[0]!.costAmount).toBe('0.3')
      expect(body.models[1]!.costAmount).toBe('0.05')
    } finally {
      await close()
    }
  })

  it('d1 keeps only sessions active in the last 24h', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const now = new Date()
    const fresh = new Date(now.getTime() - 60_000)
    const stale = new Date(now.getTime() - 25 * 60 * 60_000) // inside d7, outside d1
    await Promise.all([seedVisibleSession(AGENT_A, 'fresh', fresh), seedVisibleSession(AGENT_A, 'stale', stale)])
    // Reported the way a daemon reports, so both the snapshot and the checkpoint exist:
    // every figure is derived from the timeline, so a snapshot written on its own has
    // nothing to contribute to any window.
    for (const [sessionId, at, totalTokens] of [
      ['fresh', fresh, 700],
      ['stale', stale, 4000]
    ] as const) {
      await repo.record({
        agentId: AgentId(AGENT_A),
        sessionId,
        source: 'daemon',
        lastActivityAt: at,
        usage: { totalTokens }
      })
    }

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { from: string; to: string; totals: { sessions: number; totalTokens: number } }
      expect(Date.parse(body.to) - Date.parse(body.from)).toBe(DAY_MS)
      expect(body.totals.sessions).toBe(1)
      expect(body.totals.totalTokens).toBe(700)
    } finally {
      await close()
    }
  })

  it('does not double-count concurrent duplicate reports (idempotent spend timeline)', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000) // in-range
    await seedVisibleSession(AGENT_A, 'dup', at)
    const input = {
      agentId: AgentId(AGENT_A),
      sessionId: 'dup',
      source: 'daemon' as const,
      lastActivityAt: at,
      usage: { totalTokens: 100, costAmount: '1', costCurrency: 'USD' }
    }
    // Three identical cumulative $1 reports raced together — the old derive-delta
    // write appended one row each ($3); the cumulative upsert on (agent, session,
    // at) converges to a single row worth $1.
    await Promise.all([repo.record({ ...input }), repo.record({ ...input }), repo.record({ ...input })])
    expect(await prisma.sessionSpend.count({ where: { agentId: AGENT_A, sessionId: 'dup' } })).toBe(1)

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      const body = res.json() as {
        totals: { costAmount: string }
        series: { points: { costAmount: string }[] }
      }
      expect(body.totals.costAmount).toBe('1') // not 3
      expect(sum(body.series.points)).toBe('1')
    } finally {
      await close()
    }
  })

  it('nets a downward correction against a later increase (no double-count, no lost correction)', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const min = (m: number) => new Date(Date.now() - m * 60_000)
    await seedVisibleSession(AGENT_A, 'corr', min(10))
    // Same session, in report order: $1 → $2 → corrected down to $1.5 → $2.5.
    for (const [m, cost] of [
      [40, '1'],
      [30, '2'],
      [20, '1.5'],
      [10, '2.5']
    ] as const) {
      await repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'corr',
        source: 'daemon',
        lastActivityAt: min(m),
        usage: { costAmount: cost, costCurrency: 'USD' }
      })
    }

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      const body = res.json() as {
        totals: { costAmount: string }
        agents: { agentId: string; costAmount: string }[]
        series: { points: { costAmount: string }[] }
      }
      // Deltas 1, +1, −0.5, +1 net to the final cumulative 2.5 — not 7 (summing
      // reports) and not 5.5 (ignoring the correction).
      expect(body.totals.costAmount).toBe('2.5')
      expect(body.agents.find((a) => a.agentId === AGENT_A)!.costAmount).toBe('2.5')
      expect(sum(body.series.points)).toBe('2.5')
    } finally {
      await close()
    }
  })

  it('serves an amount at the column’s full precision without rounding a digit', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    await seedVisibleSession(AGENT_A, 'wide', at)
    // 18 fractional digits on a 3-digit integer part — 21 significant, one past what a
    // 20-significant-digit decimal library keeps. Diffing this against a zero baseline
    // is where the aggregate used to round it to …34568.
    const exact = '123.123456789012345678'
    await repo.record({
      agentId: AgentId(AGENT_A),
      sessionId: 'wide',
      source: 'gateway',
      lastActivityAt: at,
      usage: { costAmount: exact, costCurrency: 'USD' }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      const body = res.json() as {
        totals: { costAmount: string }
        agents: { agentId: string; costAmount: string }[]
        series: { points: { costAmount: string }[] }
      }
      expect(body.totals.costAmount).toBe(exact)
      expect(body.agents.find((a) => a.agentId === AGENT_A)!.costAmount).toBe(exact)
      expect(sum(body.series.points)).toBe(exact)
      // And it survived storage at full width, not just the roll-up.
      const row = await prisma.sessionUsage.findUnique({
        where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'wide' } }
      })
      expect(row!.costAmount.toFixed()).toBe(exact)
    } finally {
      await close()
    }
  })

  it('counts only in-window spend for a session that spans the range boundary (cards match chart)', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const now = Date.now()
    await seedVisibleSession(AGENT_A, 'span-win', new Date(now - 5 * 60_000))
    // $10 accrued BEFORE the d30 window, then one $11 cumulative report inside it.
    await repo.record({
      agentId: AgentId(AGENT_A),
      sessionId: 'span-win',
      source: 'daemon',
      lastActivityAt: new Date(now - 40 * DAY_MS),
      usage: { costAmount: '10', costCurrency: 'USD' }
    })
    await repo.record({
      agentId: AgentId(AGENT_A),
      sessionId: 'span-win',
      source: 'daemon',
      lastActivityAt: new Date(now - 5 * 60_000),
      usage: { costAmount: '11', costCurrency: 'USD' }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d30')}` })
      const body = res.json() as {
        totals: { costAmount: string }
        agents: { agentId: string; costAmount: string }[]
        series: { points: { costAmount: string }[] }
      }
      // Only the $1 incurred inside the window — the $10 baseline is excluded, and
      // the card, the agent row, and the chart all agree (never $11).
      expect(body.totals.costAmount).toBe('1')
      expect(body.agents.find((a) => a.agentId === AGENT_A)!.costAmount).toBe('1')
      expect(sum(body.series.points)).toBe('1')
    } finally {
      await close()
    }
  })

  it('bounds the window at BOTH ends, and shapes the series to it rather than to now', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    // A closed historical window: three whole UTC days, ending five days ago. Aligned
    // to midnight so the bucket count is exact — an unaligned window legitimately
    // touches four days, and this test is about the bound, not the alignment.
    const to = new Date(Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS)
    const from = new Date(to.getTime() - 3 * DAY_MS)
    const inside = new Date(from.getTime() + DAY_MS)
    const after = new Date(to.getTime() + DAY_MS)
    const spend = async (sessionId: string, at: Date, costAmount: string) => {
      await seedVisibleSession(AGENT_A, sessionId, at)
      await repo.record({
        agentId: AgentId(AGENT_A),
        sessionId,
        source: 'gateway',
        lastActivityAt: at,
        usage: { totalTokens: 10, costAmount, costCurrency: 'USD' }
      })
    }
    await spend('before', new Date(from.getTime() - DAY_MS), '100')
    await spend('inside', inside, '7')
    await spend('after', after, '500')

    const { app, close } = buildHttpApp(prisma)
    try {
      const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${query.toString()}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        totals: { sessions: number; costAmount: string }
        series: { bucket: string; points: { start: string; costAmount: string }[] }
      }
      // Only the middle session counts: the upper bound is what the old open-ended
      // `since` had no way to express.
      expect(body.totals.sessions).toBe(1)
      expect(body.totals.costAmount).toBe('7')
      expect(sum(body.series.points)).toBe('7')
      // The series stops at `to`, five days before now — not one bucket per day since.
      expect(body.series.bucket).toBe('day')
      const last = new Date(body.series.points.at(-1)!.start)
      expect(last.getTime()).toBeLessThan(to.getTime())
      expect(body.series.points.length).toBe(3)
      expect(body.series.points[0]!.start).toBe(from.toISOString())
    } finally {
      await close()
    }
  })

  it('scopes totals, breakdowns and series to one metering source', async () => {
    await seedAgent(prisma, AGENT_A)
    await seedAgent(prisma, AGENT_B)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    const spend = async (agentId: string, sessionId: string, source: 'daemon' | 'gateway', costAmount: string) => {
      await seedVisibleSession(agentId, sessionId, at)
      await repo.record({
        agentId: AgentId(agentId),
        sessionId,
        source,
        lastActivityAt: at,
        usage: { totalTokens: 100, costAmount, costCurrency: 'USD' }
      })
    }
    await spend(AGENT_A, 'gw', 'gateway', '12.75')
    await spend(AGENT_B, 'dm', 'daemon', '3.25')

    const { app, close } = buildHttpApp(prisma)
    try {
      const read = async (source?: string) => {
        const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1', source ? { source } : {})}` })
        expect(res.statusCode).toBe(200)
        return res.json() as {
          totals: { sessions: number; totalTokens: number; costAmount: string }
          agents: { agentId: string; costAmount: string }[]
          sources: { source: string; sessions: number; totalTokens: number; costAmount: string }[]
          series: { points: { costAmount: string }[] }
        }
      }

      const both = await read()
      expect(both.totals.costAmount).toBe('16')
      expect(both.totals.sessions).toBe(2)
      // The breakdown splits the same total by ingress, so billing can read one line
      // and the console can show the two side by side.
      expect(both.sources.map((s) => [s.source, s.costAmount]).sort()).toEqual([
        ['daemon', '3.25'],
        ['gateway', '12.75']
      ])
      expect(sumAmounts(both.sources.map((s) => s.costAmount))).toBe(both.totals.costAmount)

      const gateway = await read('gateway')
      expect(gateway.totals.costAmount).toBe('12.75')
      expect(gateway.totals.sessions).toBe(1)
      expect(gateway.totals.totalTokens).toBe(100)
      expect(gateway.agents.map((a) => a.agentId)).toEqual([AGENT_A])
      expect(gateway.sources.map((s) => s.source)).toEqual(['gateway'])
      expect(sum(gateway.series.points)).toBe('12.75')

      const daemon = await read('daemon')
      expect(daemon.totals.costAmount).toBe('3.25')
      expect(daemon.agents.map((a) => a.agentId)).toEqual([AGENT_B])
      expect(sum(daemon.series.points)).toBe('3.25')
    } finally {
      await close()
    }
  })

  // ── Attribution vs. sums ───────────────────────────────────────────────────
  // A restricted agent's spend belongs in the org's total (an org's spend is a fact
  // about the org, and it is anyway published to every member by the billing ledger)
  // but its identity does not. So the total is whole, the id never appears, and the
  // difference is one id-less residual — INDEPENDENTLY summed, so `Σ agents +
  // unattributed = totals` is an invariant a bug breaks rather than a plug figure.
  it('keeps a hidden agent’s spend in the totals, as an id-less residual', async () => {
    await seedAgent(prisma, AGENT_A)
    // Restricted and shared with someone else — invisible to this reader, who IS the org
    // owner: roles never widen resource visibility. (`sharedWith` cannot be empty; the
    // schema's `agent_selected_audience_nonempty` check refuses an audience of nobody.)
    await seedAgent(prisma, AGENT_B, { visibility: 'restricted', sharedWith: [SOMEONE_ELSE] })
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    const spend = async (agentId: string, sessionId: string, model: string, costAmount: string) => {
      await seedVisibleSession(agentId, sessionId, at, model)
      await repo.record({
        agentId: AgentId(agentId),
        sessionId,
        source: 'daemon',
        model,
        lastActivityAt: at,
        usage: { totalTokens: 100, costAmount, costCurrency: 'USD' }
      })
    }
    await spend(AGENT_A, 'visible', 'claude-sonnet-4-5', '12.75')
    await spend(AGENT_B, 'hidden', 'secret-model-only-b-uses', '3.25')

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        totals: { sessions: number; totalTokens: number; costAmount: string }
        agents: { agentId: string; costAmount: string }[]
        models: { model: string | null; costAmount: string }[]
        unattributed?: { sessions: number; totalTokens: number; costAmount: string }
        series: { points: { costAmount: string; byAgent: Record<string, string> }[] }
      }

      // The total is the org's, not the reader's slice.
      expect(body.totals.costAmount).toBe('16')
      expect(body.totals.totalTokens).toBe(200)
      expect(body.totals.sessions).toBe(2)
      // The identity is not.
      expect(body.agents.map((a) => a.agentId)).toEqual([AGENT_A])
      expect(body.unattributed).toMatchObject({ sessions: 1, totalTokens: 100, costAmount: '3.25' })
      // Not one field anywhere — not an id, and not the model only the hidden agent ran.
      const raw = JSON.stringify(body)
      expect(raw).not.toContain(AGENT_B)
      expect(raw).not.toContain('secret-model-only-b-uses')

      // THE invariant, on both attribution groupings.
      expect(sumAmounts([...body.agents.map((a) => a.costAmount), body.unattributed!.costAmount])).toBe(
        body.totals.costAmount
      )
      expect(sumAmounts([...body.models.map((m) => m.costAmount), body.unattributed!.costAmount])).toBe(
        body.totals.costAmount
      )

      // The series stays viewer-scoped, per-bucket total included: a residual resolved
      // per bucket would be the hidden agent's spend curve. So it does NOT reach the
      // total, and that is the deliberate difference rather than a drift.
      expect(sum(body.series.points)).toBe('12.75')
      expect(body.series.points.flatMap((p) => Object.keys(p.byAgent))).not.toContain(AGENT_B)
    } finally {
      await close()
    }
  })

  it('withholds a private session on a VISIBLE agent into the same residual', async () => {
    // The predicate is agent visibility AND session visibility, so the residual is not
    // "hidden agents": here the agent is listed in the very same table, and what it holds
    // is one of that agent's sessions belonging to somebody else. Which is why every
    // surface names the residual for the USAGE and never for agents.
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    await seedSessionMeta(prisma, 'shared', AGENT_A, { lastActivityAt: at })
    await seedSessionMeta(prisma, 'someone-elses', AGENT_A, {
      lastActivityAt: at,
      visibility: 'private',
      ownerIdentity: SOMEONE_ELSE
    })
    for (const [sessionId, costAmount] of [
      ['shared', '4'],
      ['someone-elses', '7']
    ] as const) {
      await repo.record({
        agentId: AgentId(AGENT_A),
        sessionId,
        source: 'daemon',
        lastActivityAt: at,
        usage: { totalTokens: 100, costAmount, costCurrency: 'USD' }
      })
    }

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        totals: { costAmount: string }
        agents: { agentId: string; costAmount: string }[]
        unattributed?: { costAmount: string }
      }
      expect(body.totals.costAmount).toBe('11')
      // The agent is right there, carrying only the session this reader may attribute.
      expect(body.agents).toEqual([expect.objectContaining({ agentId: AGENT_A, costAmount: '4' })])
      expect(body.unattributed?.costAmount).toBe('7')
    } finally {
      await close()
    }
  })

  it('omits the residual entirely when the reader can attribute every row', async () => {
    // Absent, never a zero: a caller must be able to tell "nothing was hidden" from
    // "something was hidden and it cost nothing".
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    await seedVisibleSession(AGENT_A, 'only', at)
    await repo.record({
      agentId: AgentId(AGENT_A),
      sessionId: 'only',
      source: 'daemon',
      lastActivityAt: at,
      usage: { totalTokens: 100, costAmount: '1.5', costCurrency: 'USD' }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { totals: { costAmount: string }; unattributed?: unknown }
      expect(body.totals.costAmount).toBe('1.5')
      expect(body).not.toHaveProperty('unattributed')
    } finally {
      await close()
    }
  })

  it('keeps a gateway row whose sessionId matches no session_meta (hashed credential id)', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date(Date.now() - 60_000)
    // The hub reports the model credential's hashed session id — no session_meta row exists
    // for it, so the row must fall back to agent visibility instead of being filtered out.
    await repo.record({
      agentId: AgentId(AGENT_A),
      sessionId: 'a'.repeat(64),
      source: 'gateway',
      lastActivityAt: at,
      usage: { totalTokens: 100, costAmount: '12.75', costCurrency: 'USD' }
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d1')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        totals: { sessions: number; totalTokens: number; costAmount: string; costCurrency: string | null }
        sources: { source: string; costAmount: string }[]
      }
      expect(body.totals.sessions).toBe(1)
      expect(body.totals.totalTokens).toBe(100)
      expect(body.totals.costAmount).toBe('12.75')
      // The currency read shares the viewer predicate, so it must see the unlinked row too.
      expect(body.totals.costCurrency).toBe('USD')
      expect(body.sources).toEqual([expect.objectContaining({ source: 'gateway', costAmount: '12.75' })])
    } finally {
      await close()
    }
  })

  it('keeps a session that spent in the window but reported again after it', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const to = new Date(Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS)
    const from = new Date(to.getTime() - 3 * DAY_MS)
    // The snapshot's `lastActivityAt` sits AFTER the window; its checkpoint sits inside.
    await seedVisibleSession(AGENT_A, 'cont', new Date())
    const w = (at: Date, costAmount: string, totalTokens: number) =>
      repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'cont',
        source: 'gateway',
        lastActivityAt: at,
        usage: { totalTokens, costAmount, costCurrency: 'USD' }
      })
    await w(new Date(from.getTime() + DAY_MS), '7', 100)
    await w(new Date(), '20', 400)

    const { app, close } = buildHttpApp(prisma)
    try {
      const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${query.toString()}` })
      const body = res.json() as {
        totals: { sessions: number; totalTokens: number; costAmount: string; costCurrency: string | null }
        agents: { agentId: string; costAmount: string }[]
        models: { costAmount: string }[]
        sources: { source: string; costAmount: string }[]
        series: { points: { costAmount: string }[] }
      }
      // The regression: the in-window delta reached the total and the series while the
      // session was missing from every breakdown — a response contradicting itself.
      expect(body.totals.costAmount).toBe('7')
      expect(sum(body.series.points)).toBe('7')
      expect(body.totals.sessions).toBe(1)
      // Tokens are the window's too: 100 inside it, not the 400 the session has now.
      expect(body.totals.totalTokens).toBe(100)
      expect(body.agents.map((a) => [a.agentId, a.costAmount])).toEqual([[AGENT_A, '7']])
      expect(body.sources.map((s) => [s.source, s.costAmount])).toEqual([['gateway', '7']])
      expect(sumAmounts(body.sources.map((s) => s.costAmount))).toBe(body.totals.costAmount)
      expect(sumAmounts(body.agents.map((a) => a.costAmount))).toBe(body.totals.costAmount)
      // A currency is reported because the session IS in the answer.
      expect(body.totals.costCurrency).toBe('USD')
    } finally {
      await close()
    }
  })

  it('answers a closed window the same way after more reports arrive', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const to = new Date(Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS)
    const from = new Date(to.getTime() - 3 * DAY_MS)
    await seedVisibleSession(AGENT_A, 'closed', new Date())
    const w = (at: Date, costAmount: string, totalTokens: number, model: string) =>
      repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'closed',
        source: 'gateway',
        model,
        lastActivityAt: at,
        usage: { totalTokens, costAmount, costCurrency: 'USD' }
      })
    const read = async () => {
      const { app, close } = buildHttpApp(prisma)
      try {
        const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
        const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${query.toString()}` })
        return res.json() as {
          totals: { sessions: number; totalTokens: number; costAmount: string }
          models: { model: string | null; totalTokens: number; costAmount: string }[]
        }
      } finally {
        await close()
      }
    }

    await w(new Date(from.getTime() + DAY_MS), '7', 100, 'model-in')
    const before = await read()
    // The same session keeps working AFTER the window closes, on another model.
    await w(new Date(), '20', 400, 'model-after')
    const after = await read()

    // A period is a statement about what happened during it. It must not move.
    expect(after).toEqual(before)
    expect(after.totals.totalTokens).toBe(100)
    expect(after.totals.costAmount).toBe('7')
    // And a model first used after the window never appears inside it.
    expect(after.models.map((m) => m.model)).toEqual(['model-in'])
  })

  it('refuses a window too wide to answer in one response', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      // The series allocates a bucket per day, so span is an allocation the caller
      // picks. Year 0 to year 9999 would be ~3.65M buckets.
      const wide = new URLSearchParams({ from: '0000-01-01T00:00:00.000Z', to: '9999-12-31T00:00:00.000Z' })
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${wide.toString()}` })
      expect(res.statusCode).toBe(400)

      const to = new Date()
      const ok = new URLSearchParams({
        from: new Date(to.getTime() - 400 * DAY_MS).toISOString(),
        to: to.toISOString()
      })
      expect((await app.inject({ method: 'GET', url: `${ORG}/usage?${ok.toString()}` })).statusCode).toBe(200)
      const over = new URLSearchParams({
        from: new Date(to.getTime() - 401 * DAY_MS).toISOString(),
        to: to.toISOString()
      })
      expect((await app.inject({ method: 'GET', url: `${ORG}/usage?${over.toString()}` })).statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns empty aggregates when nothing is recorded in the window', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${preset('d30')}` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        totals: { sessions: number; costAmount: string }
        agents: unknown[]
        models: unknown[]
        sources: unknown[]
      }
      expect(body.totals.sessions).toBe(0)
      expect(body.totals.costAmount).toBe('0')
      expect(body.agents).toEqual([])
      expect(body.models).toEqual([])
      expect(body.sources).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuses a window it cannot aggregate rather than inventing one', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const now = new Date().toISOString()
      const earlier = new Date(Date.now() - DAY_MS).toISOString()
      // No default window: an omitted end would give a closed accounting period a
      // moving edge, so the caller must say what it is asking for.
      for (const query of [
        '',
        `from=${now}`,
        `to=${now}`,
        `from=${now}&to=${earlier}`, // backwards
        `from=${now}&to=${now}`, // empty, and `[from, to)` makes it meaningless
        `from=not-a-date&to=${now}`
      ]) {
        const res = await app.inject({ method: 'GET', url: `${ORG}/usage?${query}` })
        expect(res.statusCode, `query: ${query || '(none)'}`).toBe(400)
      }
    } finally {
      await close()
    }
  })
})
