export interface CapacitySettings {
  concurrency: number[]
  minTurns: number
  minWaves: number
  streamDelayMs: number
  asyncPoolSize: number
  turnTimeoutMs: number
}

export interface PercentileSummary {
  p50: number
  p95: number
  p99: number
}

export interface RungSummary {
  concurrency: number
  attempted: number
  completed: number
  errors: number
  timeouts: number
  throughput: number
  infrastructureLatency: PercentileSummary
  eventLoopDelay: PercentileSummary
}

export type SaturationReason = 'infrastructure-latency' | 'throughput-gain' | 'event-loop-delay' | 'errors-or-timeouts'

export type CapacityDerivation =
  | { kind: 'below-range'; saturatedAt: number; reason: SaturationReason }
  | { kind: 'measured'; concurrency: number; saturatedAt: number; reason: SaturationReason }
  | { kind: 'at-least'; concurrency: number }

const DEFAULT_SETTINGS: CapacitySettings = {
  concurrency: [1, 2, 4, 8, 16, 32, 64],
  minTurns: 100,
  minWaves: 4,
  streamDelayMs: 5,
  asyncPoolSize: 16,
  turnTimeoutMs: 30_000
}

function parseInteger(value: string | undefined, key: string, fallback: number, minimum: number): number {
  if (value === undefined) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${key} must be an integer of at least ${minimum}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${key} must be a safe integer of at least ${minimum}`)
  }
  return parsed
}

function parseConcurrency(value: string | undefined): number[] {
  if (value === undefined) return [...DEFAULT_SETTINGS.concurrency]
  const tokens = value.split(',').map((token) => token.trim())
  if (tokens.length === 0 || tokens.some((token) => !/^[1-9]\d*$/.test(token))) {
    throw new Error('AC_PG_CAPACITY_CONCURRENCY must contain positive integers')
  }
  const concurrency = tokens.map(Number)
  for (let index = 0; index < concurrency.length; index += 1) {
    const current = concurrency[index]!
    if (!Number.isSafeInteger(current) || (index > 0 && current <= concurrency[index - 1]!)) {
      throw new Error('AC_PG_CAPACITY_CONCURRENCY must be strictly increasing safe integers')
    }
  }
  return concurrency
}

export function parseCapacitySettings(env: Record<string, string | undefined>): CapacitySettings {
  return {
    concurrency: parseConcurrency(env.AC_PG_CAPACITY_CONCURRENCY),
    minTurns: parseInteger(env.AC_PG_CAPACITY_MIN_TURNS, 'AC_PG_CAPACITY_MIN_TURNS', 100, 100),
    minWaves: parseInteger(env.AC_PG_CAPACITY_MIN_WAVES, 'AC_PG_CAPACITY_MIN_WAVES', 4, 4),
    streamDelayMs: parseInteger(env.AC_PG_CAPACITY_STREAM_DELAY_MS, 'AC_PG_CAPACITY_STREAM_DELAY_MS', 5, 0),
    asyncPoolSize: parseInteger(env.AC_PG_CAPACITY_ASYNC_POOL_SIZE, 'AC_PG_CAPACITY_ASYNC_POOL_SIZE', 16, 1),
    turnTimeoutMs: parseInteger(env.AC_PG_CAPACITY_TURN_TIMEOUT_MS, 'AC_PG_CAPACITY_TURN_TIMEOUT_MS', 30_000, 1000)
  }
}

function validateDurations(values: readonly number[]): void {
  if (values.length === 0) throw new Error('durations must not be empty')
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('durations must be finite and nonnegative')
  }
}

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  validateDurations(values)
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error('percentile must be finite and in (0, 100]')
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1]!
}

export function summarizeDurations(values: readonly number[]): PercentileSummary {
  return {
    p50: nearestRankPercentile(values, 50),
    p95: nearestRankPercentile(values, 95),
    p99: nearestRankPercentile(values, 99)
  }
}

export interface EventLoopDriftSamplerSeams<Timer = unknown> {
  now: () => number
  setInterval: (callback: () => void, delayMs: number) => Timer
  clearInterval: (timer: Timer) => void
}

export interface EventLoopDriftSampler {
  samples: readonly number[]
  stop(): readonly number[]
}

function createEventLoopDriftSamplerWithSeams<Timer>(seams: EventLoopDriftSamplerSeams<Timer>): EventLoopDriftSampler {
  const intervalMs = 10
  const samples: number[] = []
  let previousActual = seams.now()
  let stopped = false
  const sample = () => {
    const actual = seams.now()
    samples.push(Math.max(0, actual - previousActual - intervalMs))
    previousActual = actual
  }
  const timer = seams.setInterval(sample, intervalMs)
  return {
    get samples() {
      return samples
    },
    stop() {
      if (!stopped) {
        stopped = true
        sample()
        seams.clearInterval(timer)
      }
      return samples
    }
  }
}

export function createEventLoopDriftSampler<Timer>(seams?: EventLoopDriftSamplerSeams<Timer>): EventLoopDriftSampler {
  if (seams) return createEventLoopDriftSamplerWithSeams(seams)
  return createEventLoopDriftSamplerWithSeams({
    now: performance.now.bind(performance),
    setInterval,
    clearInterval
  })
}

export interface TimeoutSeams<Timer = unknown> {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => Timer
  clearTimeout: (timer: Timer) => void
}

export type MeasurementOutcome<T> =
  | { status: 'completed'; elapsedMs: number; value: T }
  | { status: 'error'; elapsedMs: number; error: unknown }
  | { status: 'timeout'; elapsedMs: number }

type SettledOperation<T> =
  { status: 'completed'; value: T } | { status: 'error'; error: unknown } | { status: 'timer-timeout' }

async function measureWithTimeoutUsingSeams<T, Timer>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
  seams: TimeoutSeams<Timer>
): Promise<MeasurementOutcome<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('timeoutMs must be finite and nonnegative')
  const startedAt = seams.now()
  const settledOperation: Promise<SettledOperation<T>> = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ status: 'completed', value }),
      (error: unknown) => ({ status: 'error', error })
    )
  let timer!: Timer
  const timerTimeout = new Promise<SettledOperation<T>>((resolve) => {
    timer = seams.setTimeout(() => resolve({ status: 'timer-timeout' }), timeoutMs)
  })
  const settled = await Promise.race([settledOperation, timerTimeout])
  seams.clearTimeout(timer)
  const elapsedMs = Math.max(0, seams.now() - startedAt)
  if (settled.status === 'timer-timeout' || elapsedMs >= timeoutMs) return { status: 'timeout', elapsedMs }
  if (settled.status === 'error') return { status: 'error', elapsedMs, error: settled.error }
  return { status: 'completed', elapsedMs, value: settled.value }
}

export function measureWithTimeout<T, Timer>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
  seams?: TimeoutSeams<Timer>
): Promise<MeasurementOutcome<T>> {
  if (seams) return measureWithTimeoutUsingSeams(operation, timeoutMs, seams)
  return measureWithTimeoutUsingSeams(operation, timeoutMs, {
    now: performance.now.bind(performance),
    setTimeout,
    clearTimeout
  })
}

function validateCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`)
}

export function validateRungAccounting(rung: RungSummary): void {
  validateCount(rung.attempted, 'attempted')
  validateCount(rung.completed, 'completed')
  validateCount(rung.errors, 'errors')
  validateCount(rung.timeouts, 'timeouts')
  if (rung.completed + rung.errors + rung.timeouts !== rung.attempted) {
    throw new Error('rung accounting must satisfy completed + errors + timeouts === attempted')
  }
}

function validateMetric(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`)
}

function saturationReason(
  rung: RungSummary,
  previous: RungSummary | undefined,
  baselineLatencyP95: number
): SaturationReason | undefined {
  if (rung.infrastructureLatency.p95 > baselineLatencyP95 * 2) return 'infrastructure-latency'
  if (previous) {
    const gain =
      previous.throughput === 0
        ? rung.throughput === 0
          ? 0
          : Number.POSITIVE_INFINITY
        : (rung.throughput - previous.throughput) / previous.throughput
    if (gain < 0.2) return 'throughput-gain'
  }
  if (rung.eventLoopDelay.p99 > 1000) return 'event-loop-delay'
  if (rung.errors > 0 || rung.timeouts > 0) return 'errors-or-timeouts'
  return undefined
}

export function deriveCapacity(rungs: readonly RungSummary[]): CapacityDerivation {
  if (rungs.length === 0) throw new Error('at least one rung is required')
  for (let index = 0; index < rungs.length; index += 1) {
    const rung = rungs[index]!
    validateRungAccounting(rung)
    validateCount(rung.concurrency, 'concurrency')
    if (rung.concurrency === 0 || (index > 0 && rung.concurrency <= rungs[index - 1]!.concurrency)) {
      throw new Error('rungs must be ordered by strictly increasing positive concurrency')
    }
    validateMetric(rung.throughput, 'throughput')
    for (const [name, summary] of [
      ['infrastructureLatency', rung.infrastructureLatency],
      ['eventLoopDelay', rung.eventLoopDelay]
    ] as const) {
      validateMetric(summary.p50, `${name}.p50`)
      validateMetric(summary.p95, `${name}.p95`)
      validateMetric(summary.p99, `${name}.p99`)
      if (summary.p50 > summary.p95 || summary.p95 > summary.p99) throw new Error(`${name} percentiles must be ordered`)
    }
  }

  const baselineLatencyP95 = rungs[0]!.infrastructureLatency.p95
  for (let index = 0; index < rungs.length; index += 1) {
    const rung = rungs[index]!
    const reason = saturationReason(rung, rungs[index - 1], baselineLatencyP95)
    if (!reason) continue
    if (index === 0) return { kind: 'below-range', saturatedAt: rung.concurrency, reason }
    return { kind: 'measured', concurrency: rungs[index - 1]!.concurrency, saturatedAt: rung.concurrency, reason }
  }
  return { kind: 'at-least', concurrency: rungs.at(-1)!.concurrency }
}
