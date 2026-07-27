/**
 * Usage dashboard end-to-end (WS `usage/report` EVT → persist → `GET /usage`).
 *
 * Two halves over the shared Testcontainers Postgres:
 *  - the `usage/report` handler persists a session's cumulative usage (latest-wins
 *    upsert on `(agentId, sessionId)`), a fire-and-forget EVT with no reply;
 *  - `GET /usage?range=…` sums the persisted store by agent over the time window,
 *    excluding sessions whose last activity falls outside the range.
 */
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AUTH_ID = '44444444-4444-4444-8444-444444444444'
const REG_ID = '55555555-5555-4555-8555-555555555555'
const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'
const DAY_MS = 24 * 60 * 60 * 1000

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
      lastActivityAt: new Date().toISOString(),
      usage: { totalTokens: 4820, inputTokens: 3600, outputTokens: 1220, cachedReadTokens: 512, costAmount: 0.41 }
    })

    // Fire-and-forget EVT — poll for the persisted row.
    const key = { agentId_sessionId: { agentId: AGENT_A, sessionId: 'acp-sess-1' } }
    await vi.waitFor(async () => {
      expect(await prisma.sessionUsage.findUnique({ where: key })).not.toBeNull()
    })
    let row = await prisma.sessionUsage.findUnique({ where: key })
    expect(row!.totalTokens).toBe(4820)
    expect(row!.inputTokens).toBe(3600)
    expect(row!.cachedReadTokens).toBe(512)
    expect(row!.costAmount).toBeCloseTo(0.41)

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

  it('drops usage for an agent not placed on the reporting daemon', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    await seedAgent(prisma, AGENT_B)
    const recordUsage = vi.spyOn(h.deps.sessionUsage, 'record')
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
    const recent = (mins: number) => new Date(now.getTime() - mins * 60_000)

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

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?range=d30` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        range: string
        totals: { sessions: number; totalTokens: number; costAmount: number; costCurrency: string | null }
        agents: { agentId: string; sessions: number; totalTokens: number; costAmount: number }[]
        series: { bucket: 'hour' | 'day'; points: { start: string; costAmount: number }[] }
      }

      expect(body.range).toBe('d30')

      // Spend-over-time series: d30 buckets daily; the three in-range sessions
      // (10/20/30 min ago) all land in the final (today) bucket, and the stale
      // 100-day row is out of window → excluded. So the series sums to 0.35.
      expect(body.series.bucket).toBe('day')
      expect(body.series.points.length).toBeGreaterThanOrEqual(30)
      const seriesTotal = body.series.points.reduce((s, p) => s + p.costAmount, 0)
      expect(seriesTotal).toBeCloseTo(0.35)
      expect(body.series.points.at(-1)!.costAmount).toBeCloseTo(0.35)

      // A local-tz offset only shifts bucket boundaries — it must never drop or
      // double-count cost. Across extreme offsets the series still sums to 0.35.
      for (const tz of [-720, 780]) {
        const r = await app.inject({ method: 'GET', url: `${ORG}/usage?range=d30&tz=${tz}` })
        const s = (r.json() as typeof body).series.points.reduce((acc, p) => acc + p.costAmount, 0)
        expect(s).toBeCloseTo(0.35)
      }
      // Stale a-old row excluded: 3 in-range sessions, 3500 tokens.
      expect(body.totals.sessions).toBe(3)
      expect(body.totals.totalTokens).toBe(3500)
      expect(body.totals.costAmount).toBeCloseTo(0.35)
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
    } finally {
      await close()
    }
  })

  it('d1 keeps only sessions active in the last 24h', async () => {
    await seedAgent(prisma, AGENT_A)
    const now = new Date()
    await prisma.sessionUsage.createMany({
      data: [
        { agentId: AGENT_A, sessionId: 'fresh', totalTokens: 700, lastActivityAt: new Date(now.getTime() - 60_000) },
        // 25h old — inside d7, outside d1.
        {
          agentId: AGENT_A,
          sessionId: 'stale',
          totalTokens: 4000,
          lastActivityAt: new Date(now.getTime() - 25 * 60 * 60_000)
        }
      ]
    })

    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage?range=d1` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { range: string; totals: { sessions: number; totalTokens: number } }
      expect(body.range).toBe('d1')
      expect(body.totals.sessions).toBe(1)
      expect(body.totals.totalTokens).toBe(700)
    } finally {
      await close()
    }
  })

  it('defaults the range to d30 and returns empty aggregates when nothing is recorded', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: `${ORG}/usage` })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { range: string; totals: { sessions: number }; agents: unknown[] }
      expect(body.range).toBe('d30')
      expect(body.totals.sessions).toBe(0)
      expect(body.agents).toEqual([])
    } finally {
      await close()
    }
  })
})
