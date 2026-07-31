import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import {
  MCP_INVOCATION_EXECUTION_TIMEOUT_MS,
  MCP_INVOCATION_REAP_INTERVAL_MS,
  McpInvocationReaper
} from './mcpInvocationReaper.js'
import { MCP_INVOCATION_RESPONSE_CACHE_TTL_MS } from '../persistence/ports.js'

const NOW = Date.parse('2026-07-30T00:00:00.000Z')

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup() {
  const calls: string[] = []
  const clock = new FakeClock(NOW)
  const invocations = {
    reap: vi.fn(async (now: Date) => {
      calls.push(`invocations:${now.toISOString()}`)
      return { markedAmbiguous: 1, deleted: 2, expiredAssertions: 1 }
    })
  }
  const delegations = {
    reapExpired: vi.fn(async (now: Date) => {
      calls.push(`delegations:${now.toISOString()}`)
      return { deleted: 3, expired: 1 }
    })
  }
  const delegationMetric = vi.fn()
  const assertionMetric = vi.fn()
  const invocationMetric = vi.fn()
  const metrics = {
    delegation: delegationMetric,
    assertion: assertionMetric,
    invocation: invocationMetric
  }
  const log = { info: vi.fn(), error: vi.fn() }
  const reaper = new McpInvocationReaper(invocations, delegations, clock, log, metrics)
  return { calls, clock, invocations, delegations, reaper, log, delegationMetric, assertionMetric, invocationMetric }
}

describe('McpInvocationReaper', () => {
  it('shares the exact 120-second execution deadline constant with MCP dispatch', async () => {
    const route = await import('../http/mcp/routes.js')
    expect(MCP_INVOCATION_EXECUTION_TIMEOUT_MS).toBe(120_000)
    expect(route.MCP_INVOCATION_EXECUTION_TIMEOUT_MS).toBe(MCP_INVOCATION_EXECUTION_TIMEOUT_MS)
  })

  it('reaps issued/running/terminal invocation state before deleting expired delegations', async () => {
    const { calls, invocations, delegations, reaper, log, delegationMetric, assertionMetric, invocationMetric } =
      setup()

    await reaper.tick()

    expect(invocations.reap).toHaveBeenCalledWith(new Date(NOW))
    expect(delegations.reapExpired).toHaveBeenCalledWith(new Date(NOW))
    expect(calls).toEqual(['invocations:2026-07-30T00:00:00.000Z', 'delegations:2026-07-30T00:00:00.000Z'])
    expect(invocationMetric).toHaveBeenCalledWith('ambiguous', 1)
    expect(assertionMetric).toHaveBeenCalledWith('expired', undefined, 1)
    expect(assertionMetric).toHaveBeenCalledTimes(1)
    expect(delegationMetric).toHaveBeenCalledWith('expired', undefined, 1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ deletedDelegations: 3 }),
      'delegated MCP invocation reaper converged durable authority'
    )
  })

  it('does not report assertion expiry for terminal-cache deletion or an empty issued batch', async () => {
    const clock = new FakeClock(NOW)
    const assertionMetric = vi.fn()
    const metrics = {
      delegation: vi.fn(),
      assertion: assertionMetric,
      invocation: vi.fn()
    }
    const reaper = new McpInvocationReaper(
      {
        reap: vi
          .fn()
          .mockResolvedValueOnce({ markedAmbiguous: 0, deleted: 4, expiredAssertions: 0 })
          .mockResolvedValueOnce({ markedAmbiguous: 0, deleted: 0, expiredAssertions: 0 })
      },
      { reapExpired: vi.fn(async () => ({ deleted: 0, expired: 0 })) },
      clock,
      undefined,
      metrics
    )

    await reaper.tick()
    await reaper.tick()

    expect(assertionMetric).not.toHaveBeenCalled()
    expect(metrics.delegation).not.toHaveBeenCalled()
  })

  it('applies issued, exact-running, terminal-cache, and dependent-delegation boundaries from a fake clock', async () => {
    type Row = {
      id: string
      status: 'issued' | 'running' | 'succeeded' | 'ambiguous'
      assertionExpires: number
      startedAt: number | null
      completedAt: number | null
    }
    const clock = new FakeClock(NOW)
    const rows: Row[] = [
      {
        id: 'issued',
        status: 'issued',
        assertionExpires: NOW + 30_000,
        startedAt: null,
        completedAt: null
      },
      {
        id: 'running',
        status: 'running',
        assertionExpires: NOW + 30_000,
        startedAt: NOW,
        completedAt: null
      },
      {
        id: 'terminal',
        status: 'succeeded',
        assertionExpires: NOW,
        startedAt: NOW,
        completedAt: NOW
      }
    ]
    let delegationPresent = true
    const invocations = {
      reap: vi.fn(async (now: Date) => {
        let markedAmbiguous = 0
        let deleted = 0
        let expiredAssertions = 0
        for (const row of rows) {
          if (
            row.status === 'running' &&
            row.startedAt !== null &&
            row.startedAt + MCP_INVOCATION_EXECUTION_TIMEOUT_MS <= now.getTime()
          ) {
            row.status = 'ambiguous'
            row.completedAt = now.getTime()
            markedAmbiguous += 1
          }
        }
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]!
          const expiredIssued = row.status === 'issued' && row.assertionExpires <= now.getTime()
          const expiredTerminal =
            (row.status === 'succeeded' || row.status === 'ambiguous') &&
            row.completedAt !== null &&
            row.completedAt + MCP_INVOCATION_RESPONSE_CACHE_TTL_MS <= now.getTime()
          if (expiredIssued || expiredTerminal) {
            rows.splice(index, 1)
            deleted += 1
            if (expiredIssued) expiredAssertions += 1
          }
        }
        return { markedAmbiguous, deleted, expiredAssertions }
      })
    }
    const delegations = {
      reapExpired: vi.fn(async (now: Date) => {
        if (delegationPresent && now.getTime() >= NOW + 30_000 && rows.length === 0) {
          delegationPresent = false
          return { deleted: 1, expired: 1 }
        }
        return { deleted: 0, expired: 0 }
      })
    }
    const reaper = new McpInvocationReaper(invocations, delegations, clock)

    clock.advance(29_999)
    await reaper.tick()
    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'issued', status: 'issued' },
      { id: 'running', status: 'running' },
      { id: 'terminal', status: 'succeeded' }
    ])

    clock.advance(1)
    await reaper.tick()
    expect(rows.some(({ id }) => id === 'issued')).toBe(false)
    expect(delegationPresent).toBe(true)

    clock.advance(MCP_INVOCATION_EXECUTION_TIMEOUT_MS - 30_001)
    await reaper.tick()
    expect(rows.find(({ id }) => id === 'running')?.status).toBe('running')

    clock.advance(1)
    await reaper.tick()
    expect(rows.find(({ id }) => id === 'running')).toMatchObject({
      status: 'ambiguous',
      completedAt: NOW + MCP_INVOCATION_EXECUTION_TIMEOUT_MS
    })

    clock.advance(MCP_INVOCATION_RESPONSE_CACHE_TTL_MS - MCP_INVOCATION_EXECUTION_TIMEOUT_MS)
    await reaper.tick()
    expect(rows.some(({ id }) => id === 'terminal')).toBe(false)
    expect(rows.some(({ id }) => id === 'running')).toBe(true)
    expect(delegationPresent).toBe(true)

    clock.advance(MCP_INVOCATION_EXECUTION_TIMEOUT_MS)
    await reaper.tick()
    expect(rows).toEqual([])
    expect(delegationPresent).toBe(false)
  })

  it('does not delete a delegation when invocation recovery fails', async () => {
    const { invocations, delegations, reaper } = setup()
    invocations.reap.mockRejectedValueOnce(new Error('db unavailable'))

    await expect(reaper.tick()).resolves.toBeUndefined()

    expect(delegations.reapExpired).not.toHaveBeenCalled()
  })

  it('starts and stops one Clock-owned periodic loop', async () => {
    const { clock, invocations, reaper } = setup()
    reaper.start()
    reaper.start()
    expect(clock.pendingTimers()).toBe(1)

    clock.advance(MCP_INVOCATION_REAP_INTERVAL_MS)
    await flush()
    expect(invocations.reap).toHaveBeenCalledTimes(1)
    expect(clock.pendingTimers()).toBe(1)

    reaper.stop()
    expect(clock.pendingTimers()).toBe(0)
    clock.advance(MCP_INVOCATION_REAP_INTERVAL_MS)
    await flush()
    expect(invocations.reap).toHaveBeenCalledTimes(1)
  })

  it('settles one in-flight tick on shutdown and performs no later delegation or DB work', async () => {
    const clock = new FakeClock(NOW)
    const invocationWork = deferred<{ markedAmbiguous: number; deleted: number; expiredAssertions: number }>()
    const invocations = { reap: vi.fn(() => invocationWork.promise) }
    const delegations = { reapExpired: vi.fn(async () => ({ deleted: 0, expired: 0 })) }
    const reaper = new McpInvocationReaper(invocations, delegations, clock)
    reaper.start()

    const firstTick = reaper.tick()
    const duplicateTick = reaper.tick()
    expect(duplicateTick).toBe(firstTick)
    expect(invocations.reap).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopping = reaper.stopAndSettle().then(() => {
      stopped = true
    })
    await flush()
    expect(stopped).toBe(false)
    expect(delegations.reapExpired).not.toHaveBeenCalled()

    invocationWork.resolve({ markedAmbiguous: 0, deleted: 0, expiredAssertions: 0 })
    await stopping
    expect(delegations.reapExpired).not.toHaveBeenCalled()
    expect(clock.pendingTimers()).toBe(0)

    clock.advance(MCP_INVOCATION_REAP_INTERVAL_MS * 2)
    await flush()
    expect(invocations.reap).toHaveBeenCalledTimes(1)
    expect(delegations.reapExpired).not.toHaveBeenCalled()
  })

  it('settles shutdown when the in-flight repository call rejects', async () => {
    const clock = new FakeClock(NOW)
    const invocationWork = deferred<{ markedAmbiguous: number; deleted: number; expiredAssertions: number }>()
    const reaper = new McpInvocationReaper(
      { reap: () => invocationWork.promise },
      { reapExpired: vi.fn(async () => ({ deleted: 0, expired: 0 })) },
      clock
    )
    const ticking = reaper.tick()
    const stopping = reaper.stopAndSettle()

    invocationWork.reject(new Error('database closed'))

    await expect(ticking).resolves.toBeUndefined()
    await expect(stopping).resolves.toBeUndefined()
  })
})
