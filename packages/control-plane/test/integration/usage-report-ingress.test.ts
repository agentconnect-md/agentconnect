/**
 * The usage report interface's NON-DAEMON adapter — `POST /internal/usage/reports`.
 *
 * Same cumulative payload as the daemon EVT, a service credential instead of a daemon
 * socket, and the same `UsageWriter` behind both. What this pins: the endpoint does not
 * exist unconfigured, an unauthenticated caller never reaches the store, either
 * credential mode authenticates (projected cluster identity or shared secret) while a
 * review outage stays retryable, accepted reports land stamped `gateway`, redelivery
 * cannot double-count, a report for a vanished agent cannot wedge the batch, and a late
 * report writes its own checkpoint without rolling the snapshot back.
 */
import { describe, it, expect, vi } from 'vitest'
import { USAGE_COLLECTOR_SA_NAME } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgSessionUsageRepo } from '../../src/persistence/repositories/session-usage.repo.js'
import { AgentId } from '../../src/domain/ids.js'

const TOKEN = 'usage-ingest-token-0123456789abcdef'
const PROJECTED = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZha2UtcHJvamVjdGVkLXRva2VuIn0.payload.sig'
const POD_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT_A = '11111111-1111-4111-8111-111111111111'
const GONE = '99999999-9999-4999-8999-999999999999'
const URL = '/api/v1/internal/usage/reports'

/** Wait until a backend is genuinely queued on a `session_spend` row lock — the interleaving the
 *  race below is written for. Sleeping a fixed guess instead runs a DIFFERENT interleaving whenever
 *  the runner is slower than the guess, and the split the test names then goes uncovered. */
async function awaitCheckpointLockWaiter(): Promise<void> {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query ILIKE '%session_spend%'
      `
      expect(rows[0]?.waiting ?? 0).toBeGreaterThanOrEqual(1)
    },
    { timeout: 20_000, interval: 10 }
  )
}

function report(sessionId: string, agentId: string, costAmount: string, at: Date) {
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

/** A stand-in for the in-cluster review: accepts one token as the collector's pod. */
function fakeClusterIdentity(opts: { accepts?: string; throws?: boolean } = {}) {
  const asked: string[] = []
  return {
    asked,
    verify: async (token: string, serviceAccount: string) => {
      asked.push(serviceAccount)
      if (opts.throws) throw new Error('api server unreachable')
      return opts.accepts !== undefined && token === opts.accepts ? { podUid: POD_UID } : null
    }
  }
}

async function withClusterApp(
  identity: ReturnType<typeof fakeClusterIdentity>,
  config: { USAGE_INGEST_TOKEN?: string; USAGE_COLLECTOR_SERVICE_ACCOUNT?: string },
  run: (app: ReturnType<typeof buildHttpApp>['app']) => Promise<void>
): Promise<void> {
  const { app, close } = buildHttpApp(prisma, config, undefined, undefined, {
    clusterWorkloadIdentity: identity
  })
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
        payload: { reports: [report('s-unconfigured', AGENT_A, '1', new Date())] }
      })
      // 404, not 401: an unconfigured deployment exposes no surface to probe.
      expect(res.statusCode).toBe(404)
    })
  })

  it('refuses a missing, malformed, or wrong bearer without touching the store', async () => {
    await seedAgent(prisma, AGENT_A)
    await withApp(true, async (app) => {
      const payload = { reports: [report('s-unauthorized', AGENT_A, '1', new Date())] }
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
      reports: [report('s-one', AGENT_A, '1.25', at), report('s-two', AGENT_A, '2.5', at)]
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
    // The reported decimal string is what landed — NUMERIC, not a float that read back
    // as 1.2500000000000002.
    expect(snapshots.map((row) => [row.sessionId, row.source, row.costAmount.toFixed(2)])).toEqual([
      ['s-one', 'gateway', '1.25'],
      ['s-two', 'gateway', '2.50']
    ])
    // Cumulative upserts: the second delivery converges onto the same checkpoints
    // rather than appending a second one per session.
    const checkpoints = await prisma.sessionSpend.findMany({ where: { agentId: AGENT_A } })
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints.every((row) => row.source === 'gateway')).toBe(true)
  })

  it('refuses the WHOLE batch when a billable amount is a float, out of range, or absent', async () => {
    await seedAgent(prisma, AGENT_A)
    const at = new Date()
    const good = report('s-good', AGENT_A, '1', at)
    const bad: Array<[string, unknown]> = [
      // A JSON number is the shape that would put a float on the money path.
      ['a JSON number', { ...report('s-float', AGENT_A, '1', at), usage: { totalTokens: 1, costAmount: 1.25 } }],
      ['exponent notation', report('s-exp', AGENT_A, '1.25e-2', at)],
      ['a negative amount', report('s-negative', AGENT_A, '-1', at)],
      ['more than 18 decimals', report('s-scale', AGENT_A, '0.0000000000000000001', at)],
      // Absent must never be read as zero spend — the caller retries once it knows.
      ['no amount', { ...report('s-missing', AGENT_A, '1', at), usage: { totalTokens: 1, costCurrency: 'USD' } }],
      ['no currency', { ...report('s-nocur', AGENT_A, '1', at), usage: { totalTokens: 1, costAmount: '1' } }]
    ]
    await withApp(true, async (app) => {
      for (const [what, offender] of bad) {
        const res = await app.inject({
          method: 'POST',
          url: URL,
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { reports: [good, offender] }
        })
        expect(res.statusCode, what).toBe(400)
      }
    })
    // Not one row: the valid sibling of a refused report is not written either.
    expect(await prisma.sessionUsage.count({ where: { agentId: AGENT_A } })).toBe(0)
  })

  it('drops a report for an agent that no longer exists and still accepts the batch', async () => {
    await seedAgent(prisma, AGENT_A)
    await withApp(true, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          reports: [report('s-gone', GONE, '9', new Date()), report('s-live', AGENT_A, '3', new Date())]
        }
      })
      // 204, not 500: a deleted agent must not wedge the caller in a retry loop.
      expect(res.statusCode).toBe(204)
    })
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-gone' } })).toBe(0)
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-live' } })).toBe(1)
  })

  it('accepts a projected cluster identity, asking only for the collector ServiceAccount', async () => {
    await seedAgent(prisma, AGENT_A)
    const identity = fakeClusterIdentity({ accepts: PROJECTED })
    await withClusterApp(identity, {}, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${PROJECTED}` },
        payload: { reports: [report('s-projected', AGENT_A, '4', new Date())] }
      })
      expect(res.statusCode).toBe(204)
    })
    // The audience alone cannot separate two workloads of one install, so the route
    // must pin the principal it will accept rather than take any reviewed token.
    expect(identity.asked).toEqual([USAGE_COLLECTOR_SA_NAME])
    const row = await prisma.sessionUsage.findUnique({
      where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 's-projected' } }
    })
    expect(row?.source).toBe('gateway')
  })

  it('asks for the ServiceAccount the deployment configured, when it names one', async () => {
    // The collector is not this codebase's pod: the deployment that runs it names it, and
    // USAGE_COLLECTOR_SERVICE_ACCOUNT is how it tells the verifying side. The default above is
    // only what an unconfigured control plane expects.
    await seedAgent(prisma, AGENT_A)
    const identity = fakeClusterIdentity({ accepts: PROJECTED })
    await withClusterApp(identity, { USAGE_COLLECTOR_SERVICE_ACCOUNT: 'ac-example-collector' }, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${PROJECTED}` },
        payload: { reports: [report('s-named', AGENT_A, '2', new Date())] }
      })
      expect(res.statusCode).toBe(204)
    })
    expect(identity.asked).toEqual(['ac-example-collector'])
  })

  it('refuses a token the cluster review rejects, with no shared secret to fall back to', async () => {
    await withClusterApp(fakeClusterIdentity({ accepts: PROJECTED }), {}, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: 'Bearer some-other-pods-token' },
        payload: { reports: [report('s-rejected', AGENT_A, '1', new Date())] }
      })
      expect(res.statusCode).toBe(401)
    })
    expect(await prisma.sessionUsage.count({ where: { sessionId: 's-rejected' } })).toBe(0)
  })

  it('answers 503, not 401, when the review itself is unreachable', async () => {
    // A retryable outage must not read to a correctly-credentialed caller as "your
    // credential is bad" — that would tell it to stop retrying.
    await withClusterApp(fakeClusterIdentity({ throws: true }), {}, async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: `Bearer ${PROJECTED}` },
        payload: { reports: [report('s-outage', AGENT_A, '1', new Date())] }
      })
      expect(res.statusCode).toBe(503)
    })
  })

  it('takes either credential when both modes are configured, sparing the review a round trip', async () => {
    await seedAgent(prisma, AGENT_A)
    const identity = fakeClusterIdentity({ accepts: PROJECTED })
    await withClusterApp(identity, { USAGE_INGEST_TOKEN: TOKEN }, async (app) => {
      for (const credential of [TOKEN, PROJECTED]) {
        const res = await app.inject({
          method: 'POST',
          url: URL,
          headers: { authorization: `Bearer ${credential}` },
          payload: { reports: [report('s-both', AGENT_A, '1', new Date())] }
        })
        expect(res.statusCode).toBe(204)
      }
    })
    // Only the projected token reached the API server; the secret matched locally.
    expect(identity.asked).toHaveLength(1)
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
    const write = (at: Date, costAmount: string, totalTokens: number) =>
      repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'late',
        source: 'gateway',
        lastActivityAt: at,
        usage: { totalTokens, costAmount, costCurrency: 'USD' }
      })

    await write(late, '5', 500)
    await write(early, '2', 200) // an out-of-order delivery arriving after a newer one

    const snapshot = await prisma.sessionUsage.findUnique({
      where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'late' } }
    })
    expect(snapshot!.costAmount.toFixed(0)).toBe('5')
    expect(snapshot!.totalTokens).toBe(500)
    expect(snapshot!.lastActivityAt.getTime()).toBe(late.getTime())
    // The timeline still keeps both cumulatives, so a range query can diff them.
    const checkpoints = await prisma.sessionSpend.findMany({
      where: { agentId: AGENT_A, sessionId: 'late' },
      orderBy: { at: 'asc' }
    })
    expect(checkpoints.map((row) => row.cumulativeCost.toFixed(0))).toEqual(['2', '5'])
  })

  describe('a checkpoint only moves forward', () => {
    const at = new Date('2026-08-18T00:00:00.000Z')
    const write = (usage: { totalTokens?: number; costAmount?: string; costCurrency?: string }) =>
      new PgSessionUsageRepo(prisma).record({
        agentId: AgentId(AGENT_A),
        sessionId: 'monotonic',
        source: 'gateway',
        lastActivityAt: at,
        usage: { costCurrency: 'USD', ...usage }
      })
    const checkpoint = () => prisma.sessionSpend.findFirst({ where: { agentId: AGENT_A, sessionId: 'monotonic' } })
    const snapshot = () =>
      prisma.sessionUsage.findUnique({
        where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'monotonic' } }
      })
    /** The snapshot and the checkpoint are read by different surfaces — `get()` and the
     *  session views from one, the aggregate's cost breakdowns from the other — so a
     *  decision that lands in only one of them is a bug even when each looks right. */
    const expectBothAt = async (totalTokens: number, cost: string) => {
      const [snap, row] = await Promise.all([snapshot(), checkpoint()])
      expect({ totalTokens: snap!.totalTokens, cost: snap!.costAmount.toFixed(2) }).toEqual({ totalTokens, cost })
      expect({ totalTokens: row!.cumulativeTotalTokens, cost: row!.cumulativeCost.toFixed(2) }).toEqual({
        totalTokens,
        cost
      })
    }

    it('ignores a straggler retry whose cumulative went backwards', async () => {
      await seedAgent(prisma, AGENT_A)
      await write({ totalTokens: 1000, costAmount: '12.75' })
      await write({ totalTokens: 400, costAmount: '5' }) // overtaken by the newer delivery

      await expectBothAt(1000, '12.75')
      // One row either way: the straggler is dropped, not stored beside it.
      expect(await prisma.sessionSpend.count({ where: { agentId: AGENT_A, sessionId: 'monotonic' } })).toBe(1)
    })

    it('lets an unchanged redelivery through as a no-op', async () => {
      await seedAgent(prisma, AGENT_A)
      await write({ totalTokens: 1000, costAmount: '12.75' })
      await write({ totalTokens: 1000, costAmount: '12.75' })

      await expectBothAt(1000, '12.75')
    })

    it('advances on a higher cumulative for the same instant', async () => {
      await seedAgent(prisma, AGENT_A)
      await write({ totalTokens: 1000, costAmount: '12.75' })
      await write({ totalTokens: 1200, costAmount: '13' })

      await expectBothAt(1200, '13.00')
    })

    it('ignores a mixed report WHOLE rather than synthesizing a checkpoint', async () => {
      await seedAgent(prisma, AGENT_A)
      await write({ totalTokens: 1000, costAmount: '12.75' })
      // Higher cost, lower tokens — no delivery ever reported this pair together.
      await write({ totalTokens: 400, costAmount: '20' })

      // Both tables: the snapshot used to take this one while the checkpoint refused
      // it, leaving the session detail and the billing rollup disagreeing.
      await expectBothAt(1000, '12.75')
    })

    it('keeps a regressive retry from making the next window bill twice', async () => {
      await seedAgent(prisma, AGENT_A)
      const repo = new PgSessionUsageRepo(prisma)
      const earlier = new Date(at.getTime() - 60_000)
      const spend = (when: Date, costAmount: string) =>
        repo.record({
          agentId: AgentId(AGENT_A),
          sessionId: 'window',
          source: 'gateway',
          lastActivityAt: when,
          usage: { totalTokens: 10, costAmount, costCurrency: 'USD' }
        })
      await spend(earlier, '10')
      await spend(at, '12')
      await spend(earlier, '4') // a stale replay of the first checkpoint

      const rows = await prisma.sessionSpend.findMany({
        where: { agentId: AGENT_A, sessionId: 'window' },
        orderBy: { at: 'asc' }
      })
      // Had the replay landed, the second checkpoint's delta would read 12 − 4 = 8
      // instead of 2, charging the 6 already billed in the earlier window a second time.
      expect(rows.map((r) => r.cumulativeCost.toFixed(0))).toEqual(['10', '12'])
    })
  })

  it('writes both tables inside ONE transaction, composing under a caller’s', async () => {
    await seedAgent(prisma, AGENT_A)
    const at = new Date('2026-08-18T00:00:00.000Z')
    // The pair must be atomic for the two fences to be one decision: separate
    // autocommit statements let concurrent incomparable reports win a table each,
    // after which neither can repair the split. Rolling back a caller's transaction
    // proves both writes sit inside it — and that `record` composed instead of
    // opening a second one, which Prisma cannot nest.
    await expect(
      prisma.$transaction(async (tx) => {
        await new PgSessionUsageRepo(tx).record({
          agentId: AgentId(AGENT_A),
          sessionId: 'atomic',
          source: 'gateway',
          lastActivityAt: at,
          usage: { totalTokens: 10, costAmount: '1', costCurrency: 'USD' }
        })
        throw new Error('caller rolls back')
      })
    ).rejects.toThrow('caller rolls back')

    expect(await prisma.sessionUsage.count({ where: { agentId: AGENT_A, sessionId: 'atomic' } })).toBe(0)
    expect(await prisma.sessionSpend.count({ where: { agentId: AGENT_A, sessionId: 'atomic' } })).toBe(0)
  })

  it('does not publish the snapshot before the checkpoint has landed', async () => {
    await seedAgent(prisma, AGENT_A)
    const repo = new PgSessionUsageRepo(prisma)
    const at = new Date('2026-08-18T00:00:00.000Z')
    const write = (totalTokens: number, costAmount: string) =>
      repo.record({
        agentId: AgentId(AGENT_A),
        sessionId: 'gated',
        source: 'gateway',
        lastActivityAt: at,
        usage: { totalTokens, costAmount, costCurrency: 'USD' }
      })
    const snapshotTokens = async () =>
      (await prisma.sessionUsage.findUnique({
        where: { agentId_sessionId: { agentId: AGENT_A, sessionId: 'gated' } }
      }))!.totalTokens
    await write(10, '1')

    // Hold the checkpoint row, so the next report's SECOND statement must wait, and
    // watch whether its FIRST statement became visible to another connection while it
    // waited. Two autocommit statements publish the snapshot mid-flight; one
    // transaction cannot. This is the split the fences alone could not prevent.
    let release!: () => void
    let markLocked!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const locked = new Promise<void>((resolve) => (markLocked = resolve))
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "session_spend"
          WHERE "agentId" = ${AGENT_A}::uuid AND "sessionId" = 'gated' FOR UPDATE`
        markLocked()
        await held
      },
      { timeout: 20_000 }
    )
    // Report only once the lock is PROVABLY held (racing `holding` so a failure there surfaces
    // instead of hanging): started earlier, the report runs to completion unblocked and the read
    // below sees its 999 without any mid-flight publish having happened.
    await Promise.race([locked, holding])
    const writing = write(999, '9')
    // Parked on the checkpoint row ⇒ its snapshot statement has already run, so this read is
    // exactly the mid-flight instant — no sleep long enough to guess at.
    await awaitCheckpointLockWaiter()
    const midFlight = await snapshotTokens()
    release()
    await holding
    await writing

    expect(midFlight).toBe(10)
    expect(await snapshotTokens()).toBe(999)
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
      usage: { totalTokens: 10, costAmount: '0.5', costCurrency: 'USD' }
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
