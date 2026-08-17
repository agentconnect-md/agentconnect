import { describe, expect, it, vi } from 'vitest'

import {
  createEventLoopDriftSampler,
  deriveCapacity,
  measureWithTimeout,
  nearestRankPercentile,
  parseCapacitySettings,
  summarizeDurations,
  validateRungAccounting,
  type RungSummary
} from './postgres-capacity-support.js'

describe('parseCapacitySettings', () => {
  it('uses documented defaults', () => {
    expect(parseCapacitySettings({})).toEqual({
      concurrency: [1, 2, 4, 8, 16, 32, 64],
      minTurns: 100,
      minWaves: 4,
      streamDelayMs: 5,
      asyncPoolSize: 16,
      turnTimeoutMs: 30_000
    })
  })

  it('parses valid overrides', () => {
    expect(
      parseCapacitySettings({
        AC_PG_CAPACITY_CONCURRENCY: '2, 5,9',
        AC_PG_CAPACITY_MIN_TURNS: '250',
        AC_PG_CAPACITY_MIN_WAVES: '7',
        AC_PG_CAPACITY_STREAM_DELAY_MS: '0',
        AC_PG_CAPACITY_ASYNC_POOL_SIZE: '3',
        AC_PG_CAPACITY_TURN_TIMEOUT_MS: '1500'
      })
    ).toEqual({
      concurrency: [2, 5, 9],
      minTurns: 250,
      minWaves: 7,
      streamDelayMs: 0,
      asyncPoolSize: 3,
      turnTimeoutMs: 1500
    })
  })

  it.each([
    ['AC_PG_CAPACITY_CONCURRENCY', ''],
    ['AC_PG_CAPACITY_CONCURRENCY', '1,1'],
    ['AC_PG_CAPACITY_CONCURRENCY', '2,1'],
    ['AC_PG_CAPACITY_CONCURRENCY', '1,0'],
    ['AC_PG_CAPACITY_CONCURRENCY', '1,2.5'],
    ['AC_PG_CAPACITY_CONCURRENCY', '1,9007199254740992'],
    ['AC_PG_CAPACITY_MIN_TURNS', '99'],
    ['AC_PG_CAPACITY_MIN_WAVES', '3'],
    ['AC_PG_CAPACITY_STREAM_DELAY_MS', '-1'],
    ['AC_PG_CAPACITY_ASYNC_POOL_SIZE', '0'],
    ['AC_PG_CAPACITY_TURN_TIMEOUT_MS', '999'],
    ['AC_PG_CAPACITY_MIN_TURNS', '100.5'],
    ['AC_PG_CAPACITY_MIN_TURNS', ' 100']
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => parseCapacitySettings({ [key]: value })).toThrow(key)
  })
})

describe('duration percentiles', () => {
  it('uses the nearest-rank definition without mutating input', () => {
    const values = [40, 10, 30, 20]
    expect(nearestRankPercentile(values, 50)).toBe(20)
    expect(nearestRankPercentile(values, 95)).toBe(40)
    expect(values).toEqual([40, 10, 30, 20])
  })

  it('summarizes ordered p50, p95, and p99', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(summarizeDurations(values)).toEqual({ p50: 50, p95: 95, p99: 99 })
  })

  it.each([
    [[], 50],
    [[1], 0],
    [[1], 101],
    [[-1], 50],
    [[Number.NaN], 50],
    [[Number.POSITIVE_INFINITY], 50]
  ])('rejects invalid values or percentile', (values, percentile) => {
    expect(() => nearestRankPercentile(values, percentile)).toThrow()
  })
})

describe('event-loop drift sampler', () => {
  it('records recurring drift and a final stop sample, then clears its timer', () => {
    let now = 100
    let callback: (() => void) | undefined
    const clearInterval = vi.fn()
    const sampler = createEventLoopDriftSampler({
      now: () => now,
      setInterval: (fn, delay) => {
        expect(delay).toBe(10)
        callback = fn
        return 42
      },
      clearInterval
    })

    now = 113
    callback?.()
    now = 119
    callback?.()
    now = 127
    expect(sampler.stop()).toEqual([3, 0, 0])
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(clearInterval).toHaveBeenCalledWith(42)
    expect(sampler.stop()).toEqual([3, 0, 0])
  })

  it('recovers after one delayed tick when later callbacks resume normal cadence', () => {
    let now = 100
    let callback: (() => void) | undefined
    const sampler = createEventLoopDriftSampler({
      now: () => now,
      setInterval: (fn) => {
        callback = fn
        return 42
      },
      clearInterval: vi.fn()
    })

    now = 130
    callback?.()
    now = 140
    callback?.()
    now = 150
    expect(sampler.stop()).toEqual([20, 0, 0])
  })
})

describe('measureWithTimeout', () => {
  it('classifies normal completion', async () => {
    await expect(measureWithTimeout(async () => 'ok', 1000)).resolves.toMatchObject({
      status: 'completed',
      value: 'ok'
    })
  })

  it('classifies an operation error', async () => {
    const error = new Error('boom')
    await expect(measureWithTimeout(async () => Promise.reject(error), 1000)).resolves.toMatchObject({
      status: 'error',
      error
    })
  })

  it('classifies a timer-race timeout and consumes a later rejection', async () => {
    let rejectOperation!: (error: Error) => void
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject
    })
    const resultPromise = measureWithTimeout(() => operation, 5)
    await expect(resultPromise).resolves.toMatchObject({ status: 'timeout' })
    rejectOperation(new Error('late'))
    await Promise.resolve()
  })

  it('classifies elapsed-wall-time timeout when the timer callback was delayed', async () => {
    let now = 0
    const result = await measureWithTimeout(
      async () => {
        now = 1500
        return 'late'
      },
      1000,
      {
        now: () => now,
        setTimeout: () => 7,
        clearTimeout: vi.fn()
      }
    )
    expect(result).toEqual({ status: 'timeout', elapsedMs: 1500 })
  })
})

function rung(overrides: Partial<RungSummary> = {}): RungSummary {
  return {
    concurrency: 1,
    attempted: 100,
    completed: 100,
    errors: 0,
    timeouts: 0,
    throughput: 100,
    infrastructureLatency: { p50: 10, p95: 10, p99: 10 },
    eventLoopDelay: { p50: 0, p95: 0, p99: 0 },
    ...overrides
  }
}

describe('rung accounting', () => {
  it('accepts exact accounting and rejects mismatches or invalid counts', () => {
    expect(() => validateRungAccounting(rung())).not.toThrow()
    expect(() => validateRungAccounting(rung({ completed: 99 }))).toThrow('accounting')
    expect(() => validateRungAccounting(rung({ errors: -1, completed: 101 }))).toThrow()
  })
})

describe('deriveCapacity', () => {
  it.each([
    ['infrastructure-latency', rung({ concurrency: 2, infrastructureLatency: { p50: 10, p95: 21, p99: 21 } })],
    ['throughput-gain', rung({ concurrency: 2, throughput: 119 })],
    ['event-loop-delay', rung({ concurrency: 2, throughput: 130, eventLoopDelay: { p50: 0, p95: 0, p99: 1001 } })],
    ['errors-or-timeouts', rung({ concurrency: 2, throughput: 130, completed: 99, errors: 1 })],
    ['errors-or-timeouts', rung({ concurrency: 2, throughput: 130, completed: 99, timeouts: 1 })]
  ])('detects %s saturation', (reason, saturated) => {
    expect(deriveCapacity([rung(), saturated])).toEqual({
      kind: 'measured',
      concurrency: 1,
      saturatedAt: 2,
      reason
    })
  })

  it('uses the concurrency-1 latency baseline at later rungs', () => {
    expect(
      deriveCapacity([
        rung(),
        rung({ concurrency: 2, throughput: 130, infrastructureLatency: { p50: 10, p95: 19, p99: 19 } }),
        rung({ concurrency: 4, throughput: 170, infrastructureLatency: { p50: 10, p95: 21, p99: 21 } })
      ])
    ).toMatchObject({ kind: 'measured', concurrency: 2, reason: 'infrastructure-latency' })
  })

  it('reports below range when the first rung has failures', () => {
    expect(deriveCapacity([rung({ completed: 99, errors: 1 })])).toEqual({
      kind: 'below-range',
      saturatedAt: 1,
      reason: 'errors-or-timeouts'
    })
  })

  it('reports at least the bound when no rung saturates', () => {
    expect(deriveCapacity([rung(), rung({ concurrency: 2, throughput: 130 })])).toEqual({
      kind: 'at-least',
      concurrency: 2
    })
  })

  it('does not saturate at exact threshold boundaries', () => {
    expect(
      deriveCapacity([
        rung(),
        rung({
          concurrency: 2,
          throughput: 120,
          infrastructureLatency: { p50: 10, p95: 20, p99: 20 },
          eventLoopDelay: { p50: 0, p95: 0, p99: 1000 }
        })
      ])
    ).toEqual({ kind: 'at-least', concurrency: 2 })
  })

  it('uses the specified reason precedence when triggers are simultaneous', () => {
    expect(
      deriveCapacity([
        rung(),
        rung({
          concurrency: 2,
          throughput: 100,
          infrastructureLatency: { p50: 10, p95: 21, p99: 21 },
          eventLoopDelay: { p50: 0, p95: 0, p99: 1001 },
          completed: 99,
          errors: 1
        })
      ])
    ).toMatchObject({ reason: 'infrastructure-latency' })
  })

  it('prefers throughput gain over simultaneous event-loop and failure triggers', () => {
    expect(
      deriveCapacity([
        rung(),
        rung({
          concurrency: 2,
          throughput: 119,
          eventLoopDelay: { p50: 0, p95: 0, p99: 1001 },
          completed: 99,
          errors: 1
        })
      ])
    ).toMatchObject({ reason: 'throughput-gain' })
  })

  it('prefers event-loop delay over simultaneous failure triggers', () => {
    expect(
      deriveCapacity([
        rung(),
        rung({
          concurrency: 2,
          throughput: 120,
          eventLoopDelay: { p50: 0, p95: 0, p99: 1001 },
          completed: 99,
          timeouts: 1
        })
      ])
    ).toMatchObject({ reason: 'event-loop-delay' })
  })

  it('validates suffix rungs even after an earlier saturation', () => {
    expect(() =>
      deriveCapacity([
        rung(),
        rung({ concurrency: 2, throughput: 100 }),
        rung({ concurrency: 1, throughput: Number.NaN, completed: 99 })
      ])
    ).toThrow()
  })

  it('rejects empty, unordered, or incorrectly accounted rungs', () => {
    expect(() => deriveCapacity([])).toThrow()
    expect(() => deriveCapacity([rung({ concurrency: 2 }), rung({ concurrency: 1 })])).toThrow('ordered')
    expect(() => deriveCapacity([rung({ completed: 99 })])).toThrow('accounting')
  })
})
