/**
 * The usage report interface's NON-DAEMON adapter — `POST /internal/usage/reports`.
 *
 * Same cumulative payload as the daemon EVT, a deployment-shared service credential
 * instead of a daemon socket, and the same `UsageWriter` behind both. What this pins:
 * the endpoint does not exist unconfigured, an unauthenticated caller never reaches
 * the store, accepted reports land stamped `gateway`, redelivery cannot double-count,
 * a report for a vanished agent cannot wedge the batch, and a late report writes its
 * own checkpoint without rolling the snapshot back.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgSessionUsageRepo } from '../../src/persistence/repositories/session-usage.repo.js'
import { AgentId } from '../../src/domain/ids.js'

const TOKEN = 'usage-ingest-token-0123456789abcdef'
const AGENT_A = '11111111-1111-4111-8111-111111111111'
const GONE = '99999999-9999-4999-8999-999999999999'
const URL = '/api/v1/internal/usage/reports'

function report(sessionId: string, agentId: string, costAmount: number, at: Date) {
  return {
    sessionId,
    agentId,
    platform: 'webchat',
    observedModel: 'gpt-5',
    lastActivityAt: at.toISOString(),
    usage: { totalTokens: 1000, inputTokens: 800, outputTokens: 200, costAmount, costCurrency: 'USD' }
  }
}

async function withApp(
  configured: boolean,
  run: (app: ReturnType<typeof buildHttpApp>['app']) => Promise<void>
): Promise<void> {
  const { app, close } = buildHttpApp(prisma, configured ? { USAGE_INGEST_TOKEN: TOKEN } : {})
  try {
    await run(app)
  } finally {
    await close()
  }
}

describe('POST /internal/usage/reports — the gateway-source usage adapter', () => {
  it('is not registered at all when no service credential is configured', async () => {
    await withApp(false, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { reports: [report('s-unconfigured', AGENT_A, 1, new Date())] }
      })
      // 404, not 401: an unconfigured deployment exposes no surface to probe.
      expect(res.statusCode).toBe(404)
    })
  })

  it('refuses a missing, malformed, or wrong bearer without touching the store', async () => {
    await seedAgent(prisma, AGENT_A)
    await withApp(true, async (app) => {
      const payload = { reports: [report('s-unauthorized', AGENT_A, 1, new Date())] }
      for (const headers of [
        {},
        { authorization: TOKEN }, // no scheme
        { authorization: `Basic ${TOKEN}` },
        { authorization: `Bearer ${TOKEN}x` },
        { authorization: 'Bearer ' }
      ]) {
        const res = await app.inject({ method: 'POST', url: URL, headers, payload })
        expect(res.statusCode).toBe(401)
      }
    })
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-unauthorized' } })).toBe(0)
  })

  it('records an authenticated batch as `gateway`, and redelivery does not double-count', async () => {
    await seedAgent(prisma, AGENT_A)
    const at = new Date()
    const payload = {
      reports: [report('s-one', AGENT_A, 1.25, at), report('s-two', AGENT_A, 2.5, at)]
    }
    await withApp(true, async (app) => {
      for (const _attempt of [1, 2]) {
        const res = await app.inject({
          method: 'POST',
          url: URL,
          headers: { authorization: `Bearer ${TOKEN}` },
          payload
        })
        expect(res.statusCode).toBe(204)
      }
    })

    const snapshots = await prisma.sessionUsage.findMany({
      where: { agentId: AGENT_A },
      orderBy: { sessionId: 'asc' }
    })
    expect(snapshots.map((row) => [row.sessionId, row.source, row.costAmount])).toEqual([
      ['s-one', 'gateway', 1.25],
      ['s-two', 'gateway', 2.5]
    ])
    // Cumulative upserts: the second delivery converges onto the same checkpoints
    // rather than appending a second one per session.
    const checkpoints = await prisma.sessionSpend.findMany({ where: { agentId: AGENT_A } })
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints.every((row) => row.source === 'gateway')).toBe(true)
  })

  it('drops a report for an agent that no longer exists and still accepts the batch', async () => {
    await seedAgent(prisma, AGENT_A)
    await withApp(true, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          reports: [report('s-gone', GONE, 9, new Date()), report('s-live', AGENT_A, 3, new Date())]
        }
      })
      // 204, not 500: a deleted agent must not wedge the caller in a retry loop.
      expect(res.statusCode).toBe(204)
    })
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-gone' } })).toBe(0)
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-live' } })).toBe(1)
  })

  it('rejects an empty batch', async () => {
    await withApp(true, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { reports: [] }
      })
      expect(res.statusCode).toBe(400)
    })
  })
})

describe('the shared store semantics both adapters get', () => {
  it('lets a late report write its own checkpoint without rolling the snapshot back', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const early = new Date(Date.now() - 60_000)
    const late = new Date()
    const write = (at: Date, costAmount: number, totalTokens: number) =>
      repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'late',
        source: 'gateway',
        lastActivityAt: at,
        usage: { totalTokens, costAmount, costCurrency: 'USD' }
      })

    await write(late, 5, 500)
    await write(early, 2, 200) // an out-of-order delivery arriving after a newer one

    const snapshot = await prisma.sessionUsage.findUnique({
      where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'late' } }
    })
    expect(snapshot!.costAmount).toBeCloseTo(5)
    expect(snapshot!.totalTokens).toBe(500)
    expect(snapshot!.lastActivityAt.getTime()).toBe(late.getTime())
    // The timeline still keeps both cumulatives, so a range query can diff them.
    const checkpoints = await prisma.sessionSpend.findMany({
      where: { agentId: AGENT_A, sessionId: 'late' },
      orderBy: { at: 'asc' }
    })
    expect(checkpoints.map((row) => row.cumulativeCost)).toEqual([2, 5])
  })

  it('re-applies an unchanged snapshot idempotently rather than skipping it', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date()
    const input = {
      agentId: AgentId(AGENT_A),
      sessionId: 'replay',
      source: 'gateway' as const,
      lastActivityAt: at,
      usage: { totalTokens: 10, costAmount: 0.5, costCurrency: 'USD' }
    }
    await repo.record(input)
    await repo.record({ ...input, usage: { ...input.usage, totalTokens: 20 } })

    const snapshot = await prisma.sessionUsage.findUnique({
      where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'replay' } }
    })
    // Same `at` ⇒ still the newest report, so a corrected count for that instant wins.
    expect(snapshot!.totalTokens).toBe(20)
    expect(await prisma.sessionSpend.count({ where: { agentId: AGENT_A, sessionId: 'replay' } })).toBe(1)
  })
})
