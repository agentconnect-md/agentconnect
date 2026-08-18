import assert from 'node:assert/strict'
import { cpus } from 'node:os'

import { Client } from 'pg'
import { describe, inject, it } from 'vitest'

import { PostgresDataPlane } from '../../src/store/postgres-data-plane.js'
import {
  createEventLoopDriftSampler,
  deriveCapacity,
  measureWithTimeout,
  parseCapacitySettings,
  summarizeDurations,
  validateRungAccounting,
  type CapacityDerivation,
  type CapacitySettings,
  type PercentileSummary,
  type RungSummary,
  type TimeoutSeams
} from './postgres-capacity-support.js'
import { createPostgresDaemonHarness, type HarnessVerification } from './postgres-daemon-harness.js'
import { runPostgresTraceContract } from './postgres-trace-contract.bench.js'
import {
  AsyncTraceExecutor,
  SyncWorkerTraceExecutor,
  initializeTraceSchema,
  resetTraceSchema,
  runSyntheticTrace,
  type TraceExecutor
} from './postgres-trace.js'

const BENCHMARK_ORGANIZATION = 'benchmark-org'
const DAEMON_EMISSIONS = 38
const DAEMON_TOOLS = 6
const DAEMON_TOOL_UPDATES = 5
const TRACE_HANDOFFS = 17
const TRACE_SQL_STATEMENTS = 21
const TRACE_LOGICAL_BATCHES = 4
const TRACE_STATEMENTS_PER_BATCH = 2

interface ReportRung extends RungSummary {
  waves: number
  latency: PercentileSummary
  eventLoopDelayMax: number
}

interface DaemonVerificationReport extends HarnessVerification {
  concurrency: number
}

interface LadderReport {
  rungs: ReportRung[]
  capacity: CapacityDerivation
}

interface RatioReport {
  concurrency: number
  throughputSpeedup: number | null
  p95LatencyRatio: number | null
}

interface CapacityReport {
  schemaVersion: 1
  warning: string
  environment: {
    node: string
    platform: NodeJS.Platform
    arch: string
    cpu: { model: string; count: number }
    postgres: { image: string; version: string }
  }
  settings: CapacitySettings
  workload: {
    daemon: {
      emissions: 38
      reasoning: 1
      tools: 6
      updatesPerTool: 5
      pauses: 38
      inboxExcluded: true
    }
    trace: {
      handoffs: 17
      totalSqlStatements: 21
      logicalBatches: 4
      statementsPerBatch: 2
    }
  }
  executorEquivalence: { realPostgres: true; concurrentTraceCount: 2 }
  daemon: LadderReport & { verification: DaemonVerificationReport[] }
  traces: {
    syncWorker: LadderReport
    asyncSingle: LadderReport
    asyncPool: LadderReport & { poolSize: number }
  }
  ratios: {
    asyncSingleOverSync: RatioReport[]
    asyncPoolOverAsyncSingle: RatioReport[]
  }
}

async function resetBenchmarkDatabase(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS agentconnect_capacity_bench CASCADE')
    await client.query('DROP SCHEMA IF EXISTS agentconnect_cloud_store CASCADE')
  } finally {
    await client.end()
  }
}

function eventLoopMaximum(samples: readonly number[]): number {
  return samples.reduce((maximum, sample) => Math.max(maximum, sample), 0)
}

async function runDaemonRung(
  databaseUrl: string,
  settings: CapacitySettings,
  concurrency: number
): Promise<{ rung: ReportRung; verification: DaemonVerificationReport }> {
  await resetBenchmarkDatabase(databaseUrl)
  let harness: Awaited<ReturnType<typeof createPostgresDaemonHarness>> | undefined
  try {
    harness = await createPostgresDaemonHarness({
      concurrency,
      streamDelayMs: settings.streamDelayMs,
      organizationId: BENCHMARK_ORGANIZATION,
      openDataPlane: (orgForAgent, onFailure) =>
        PostgresDataPlane.open(
          { version: 1, databaseUrl, maxConnections: settings.asyncPoolSize },
          orgForAgent,
          onFailure
        )
    })
    const measured = await harness.runRung(settings)
    await harness.waitUntilIdle(Math.max(30_000, settings.turnTimeoutMs * 2))
    const verification = await harness.verification()
    const healthy = measured.summary.errors === 0 && measured.summary.timeouts === 0
    assert.equal(verification.completedOutputs, measured.summary.completed)
    assert.equal(verification.terminalSessions, concurrency)
    assert.equal(verification.reasoningRows >= measured.summary.completed, true)
    assert.equal(verification.toolRows >= measured.summary.completed * DAEMON_TOOLS, true)
    assert.deepStrictEqual(
      Object.fromEntries(harness.agentIds.map((agentId) => [agentId, BENCHMARK_ORGANIZATION])),
      verification.resolvedOrganizationByAgent
    )
    if (healthy) {
      assert.equal(measured.summary.completed >= settings.minTurns, true)
      assert.equal(measured.raw.waves >= settings.minWaves, true)
      assert.equal(verification.reasoningRows, measured.summary.completed)
      assert.equal(verification.toolRows, measured.summary.completed * DAEMON_TOOLS)
    }
    return {
      rung: {
        ...measured.summary,
        waves: measured.raw.waves,
        latency: measured.raw.latencySummary,
        eventLoopDelayMax: eventLoopMaximum(measured.raw.eventLoopSamples)
      },
      verification: { concurrency, ...verification }
    }
  } finally {
    try {
      await harness?.close()
    } finally {
      await resetBenchmarkDatabase(databaseUrl)
    }
  }
}

async function collectConfiguredRungs<T>(
  concurrency: readonly number[],
  run: (value: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = []
  for (const value of concurrency) {
    const result = await run(value)
    results.push(result)
  }
  return results
}

async function runDaemonLadder(
  databaseUrl: string,
  settings: CapacitySettings
): Promise<LadderReport & { verification: DaemonVerificationReport[] }> {
  const rungs: ReportRung[] = []
  const verification: DaemonVerificationReport[] = []
  const results = await collectConfiguredRungs(settings.concurrency, (concurrency) =>
    runDaemonRung(databaseUrl, settings, concurrency)
  )
  for (const result of results) {
    rungs.push(result.rung)
    verification.push(result.verification)
  }
  return { rungs, capacity: deriveCapacity(rungs), verification }
}

const yieldAfterHandoff = () => new Promise<void>((resolve) => setImmediate(resolve))

function measureTraceSlot<T, Timer = ReturnType<typeof setTimeout>>(
  startWork: () => Promise<T>,
  timeoutMs: number,
  lateWork: Promise<unknown>[],
  seams?: TimeoutSeams<Timer>
) {
  const measuredWork = () => {
    const work = startWork()
    lateWork.push(work)
    return work
  }
  return seams ? measureWithTimeout(measuredWork, timeoutMs, seams) : measureWithTimeout(measuredWork, timeoutMs)
}

async function runTraceRung(
  databaseUrl: string,
  settings: CapacitySettings,
  mode: string,
  concurrency: number,
  createExecutor: () => TraceExecutor
): Promise<ReportRung> {
  await resetBenchmarkDatabase(databaseUrl)
  const executor = createExecutor()
  try {
    await initializeTraceSchema(executor)
    await Promise.all(
      Array.from({ length: concurrency }, (_, slot) =>
        runSyntheticTrace(
          executor,
          { agentId: `${mode}-agent-${slot + 1}`, turnId: `${mode}-c${concurrency}-warm-${slot + 1}` },
          yieldAfterHandoff
        )
      )
    )
    await resetTraceSchema(executor)
    const sampler = createEventLoopDriftSampler()
    const lateWork: Promise<unknown>[] = []
    const latencies: number[] = []
    let waves = 0
    let attempted = 0
    let completed = 0
    let errors = 0
    let timeouts = 0
    let healthy = true
    const startedAt = performance.now()
    try {
      while (healthy && (completed < settings.minTurns || waves < settings.minWaves)) {
        waves += 1
        const outcomes = await Promise.all(
          Array.from({ length: concurrency }, (_, slot) => {
            return measureTraceSlot(
              () =>
                runSyntheticTrace(
                  executor,
                  {
                    agentId: `${mode}-agent-${slot + 1}`,
                    turnId: `${mode}-c${concurrency}-wave-${waves}-slot-${slot + 1}`
                  },
                  yieldAfterHandoff
                ),
              settings.turnTimeoutMs,
              lateWork
            )
          })
        )
        attempted += outcomes.length
        for (const outcome of outcomes) {
          latencies.push(outcome.elapsedMs)
          if (outcome.status === 'completed') completed += 1
          else if (outcome.status === 'error') errors += 1
          else timeouts += 1
        }
        healthy = outcomes.every((outcome) => outcome.status === 'completed')
      }
      await Promise.allSettled(lateWork)
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, Number.EPSILON)
      const eventLoopSamples = [...sampler.stop()]
      const latency = summarizeDurations(latencies)
      return {
        concurrency,
        attempted,
        completed,
        errors,
        timeouts,
        throughput: completed / elapsedSeconds,
        infrastructureLatency: latency,
        eventLoopDelay: summarizeDurations(eventLoopSamples),
        waves,
        latency,
        eventLoopDelayMax: eventLoopMaximum(eventLoopSamples)
      }
    } finally {
      sampler.stop()
      await Promise.allSettled(lateWork)
    }
  } finally {
    try {
      await executor.close()
    } finally {
      await resetBenchmarkDatabase(databaseUrl)
    }
  }
}

async function runTraceLadder(
  databaseUrl: string,
  settings: CapacitySettings,
  mode: string,
  createExecutor: () => TraceExecutor
): Promise<LadderReport> {
  const rungs = await collectConfiguredRungs(settings.concurrency, (concurrency) =>
    runTraceRung(databaseUrl, settings, mode, concurrency, createExecutor)
  )
  return { rungs, capacity: deriveCapacity(rungs) }
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  const value = numerator / denominator
  return Number.isFinite(value) ? value : null
}

function matchedRatios(numerator: readonly ReportRung[], denominator: readonly ReportRung[]): RatioReport[] {
  const denominatorByConcurrency = new Map(denominator.map((rung) => [rung.concurrency, rung]))
  return numerator.flatMap((rung) => {
    const baseline = denominatorByConcurrency.get(rung.concurrency)
    if (!baseline) return []
    return [
      {
        concurrency: rung.concurrency,
        throughputSpeedup: safeRatio(rung.throughput, baseline.throughput),
        p95LatencyRatio: safeRatio(baseline.infrastructureLatency.p95, rung.infrastructureLatency.p95)
      }
    ]
  })
}

function assertOrderedMetrics(summary: PercentileSummary): void {
  for (const value of [summary.p50, summary.p95, summary.p99]) {
    assert.equal(Number.isFinite(value) && value >= 0, true)
  }
  assert.equal(summary.p50 <= summary.p95 && summary.p95 <= summary.p99, true)
}

function validateLadder(ladder: LadderReport, settings: CapacitySettings, label: string): void {
  assert.equal(ladder.rungs.length > 0, true)
  assert.deepStrictEqual(
    ladder.rungs.map((rung) => rung.concurrency),
    settings.concurrency,
    `${label} rungs must exactly match configured concurrency`
  )
  for (const rung of ladder.rungs) {
    validateRungAccounting(rung)
    assertOrderedMetrics(rung.latency)
    assertOrderedMetrics(rung.infrastructureLatency)
    assertOrderedMetrics(rung.eventLoopDelay)
    assert.equal(Number.isFinite(rung.throughput) && rung.throughput >= 0, true)
    assert.equal(Number.isFinite(rung.eventLoopDelayMax) && rung.eventLoopDelayMax >= 0, true)
    if (rung.errors === 0 && rung.timeouts === 0) {
      assert.equal(rung.completed >= settings.minTurns, true)
      assert.equal(rung.waves >= settings.minWaves, true)
    }
  }
  assert.deepStrictEqual(ladder.capacity, deriveCapacity(ladder.rungs))
}

function validateDaemonVerification(report: CapacityReport): void {
  assert.equal(
    report.daemon.verification.length,
    report.daemon.rungs.length,
    'daemon verification count must match daemon rungs'
  )
  for (let index = 0; index < report.daemon.rungs.length; index += 1) {
    const rung = report.daemon.rungs[index]!
    const verification = report.daemon.verification[index]!
    assert.equal(verification.concurrency, rung.concurrency, 'daemon verification concurrency must align with its rung')
    const organizations = Object.values(verification.resolvedOrganizationByAgent)
    assert.equal(organizations.length, rung.concurrency, 'daemon organization cardinality must match concurrency')
    assert.equal(
      organizations.every((organization) => organization === BENCHMARK_ORGANIZATION),
      true,
      'daemon organization resolutions must use benchmark-org'
    )
    assert.equal(verification.completedOutputs, rung.completed, 'daemon verification completed outputs mismatch')
    assert.equal(verification.terminalSessions, rung.concurrency, 'daemon verification terminal sessions mismatch')
    assert.equal(
      verification.reasoningRows >= rung.completed,
      true,
      'daemon verification reasoning rows must cover completed turns'
    )
    assert.equal(
      verification.toolRows >= rung.completed * DAEMON_TOOLS,
      true,
      'daemon verification tool rows must cover completed turns'
    )
    if (rung.errors === 0 && rung.timeouts === 0) {
      assert.equal(verification.reasoningRows, rung.completed, 'daemon verification reasoning rows mismatch')
      assert.equal(verification.toolRows, rung.completed * DAEMON_TOOLS, 'daemon verification tool rows mismatch')
    }
  }
}

function validateRatioCoverage(
  ratios: readonly RatioReport[],
  numerator: readonly ReportRung[],
  denominator: readonly ReportRung[],
  settings: CapacitySettings,
  label: string
): void {
  assert.deepStrictEqual(
    ratios.map((ratio) => ratio.concurrency),
    settings.concurrency,
    `${label} ratio concurrency must exactly match configured concurrency`
  )
  for (const ratio of ratios) {
    for (const value of [ratio.throughputSpeedup, ratio.p95LatencyRatio]) {
      assert.equal(
        value === null || (Number.isFinite(value) && value >= 0),
        true,
        `${label} ratio fields must be nonnegative finite values or null`
      )
    }
  }
  assert.deepStrictEqual(ratios, matchedRatios(numerator, denominator), `${label} ratio values must match rung data`)
}

function validateProvenance(report: CapacityReport): void {
  assert.equal(report.warning.trim().length > 0, true, 'report warning must be nonempty')
  for (const [name, value] of [
    ['node', report.environment.node],
    ['platform', report.environment.platform],
    ['arch', report.environment.arch],
    ['cpu model', report.environment.cpu.model],
    ['postgres image', report.environment.postgres.image],
    ['postgres version', report.environment.postgres.version]
  ] as const) {
    assert.equal(value.trim().length > 0, true, `environment ${name} must be nonempty`)
  }
  assert.equal(
    Number.isSafeInteger(report.environment.cpu.count) && report.environment.cpu.count > 0,
    true,
    'environment cpu count must be a positive safe integer'
  )
  assert.deepStrictEqual(
    report.executorEquivalence,
    { realPostgres: true, concurrentTraceCount: 2 },
    'executor equivalence must declare the real two-trace PostgreSQL contract'
  )
  assert.equal(
    report.traces.asyncPool.poolSize,
    report.settings.asyncPoolSize,
    'async pool size must match configured asyncPoolSize'
  )
}

function validateReport(report: CapacityReport): string {
  assert.equal(report.schemaVersion, 1)
  validateProvenance(report)
  assert.deepStrictEqual(report.workload.daemon, {
    emissions: DAEMON_EMISSIONS,
    reasoning: 1,
    tools: DAEMON_TOOLS,
    updatesPerTool: DAEMON_TOOL_UPDATES,
    pauses: DAEMON_EMISSIONS,
    inboxExcluded: true
  })
  assert.deepStrictEqual(
    report.workload.trace,
    {
      handoffs: TRACE_HANDOFFS,
      totalSqlStatements: TRACE_SQL_STATEMENTS,
      logicalBatches: TRACE_LOGICAL_BATCHES,
      statementsPerBatch: TRACE_STATEMENTS_PER_BATCH
    },
    'trace workload must declare the exact synthetic trace shape'
  )
  validateLadder(report.daemon, report.settings, 'daemon')
  validateLadder(report.traces.syncWorker, report.settings, 'sync-worker')
  validateLadder(report.traces.asyncSingle, report.settings, 'async-single')
  validateLadder(report.traces.asyncPool, report.settings, 'async-pool')
  validateDaemonVerification(report)
  validateRatioCoverage(
    report.ratios.asyncSingleOverSync,
    report.traces.asyncSingle.rungs,
    report.traces.syncWorker.rungs,
    report.settings,
    'async-single/sync-worker'
  )
  validateRatioCoverage(
    report.ratios.asyncPoolOverAsyncSingle,
    report.traces.asyncPool.rungs,
    report.traces.asyncSingle.rungs,
    report.settings,
    'async-pool/async-single'
  )
  const serialized = JSON.stringify(report)
  assert.deepStrictEqual(JSON.parse(serialized), report)
  return serialized
}

function emitReport(report: CapacityReport, writer: (line: string) => void): void {
  writer(validateReport(report))
}

function testRung(concurrency: number): ReportRung {
  const latency = { p50: 1, p95: 2, p99: 3 }
  return {
    concurrency,
    attempted: 100,
    completed: 100,
    errors: 0,
    timeouts: 0,
    throughput: concurrency * 100,
    infrastructureLatency: { ...latency },
    eventLoopDelay: { ...latency },
    waves: 100,
    latency: { ...latency },
    eventLoopDelayMax: 4
  }
}

function testReport(): CapacityReport {
  const settings: CapacitySettings = {
    concurrency: [1, 2],
    minTurns: 100,
    minWaves: 4,
    streamDelayMs: 0,
    asyncPoolSize: 2,
    turnTimeoutMs: 1000
  }
  const ladder = (): LadderReport => {
    const rungs = settings.concurrency.map(testRung)
    return { rungs, capacity: deriveCapacity(rungs) }
  }
  const daemon = {
    ...ladder(),
    verification: settings.concurrency.map((concurrency) => ({
      concurrency,
      completedOutputs: 100,
      terminalSessions: concurrency,
      reasoningRows: 100,
      toolRows: 600,
      resolvedOrganizationByAgent: Object.fromEntries(
        Array.from({ length: concurrency }, (_, index) => [`agent-${index + 1}`, BENCHMARK_ORGANIZATION])
      )
    }))
  }
  const syncWorker = ladder()
  const asyncSingle = ladder()
  const asyncPool = ladder()
  return {
    schemaVersion: 1,
    warning: 'Synthetic benchmark test report.',
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: { model: 'test', count: 1 },
      postgres: { image: 'postgres:16-alpine', version: '16' }
    },
    settings,
    workload: {
      daemon: {
        emissions: DAEMON_EMISSIONS,
        reasoning: 1,
        tools: DAEMON_TOOLS,
        updatesPerTool: DAEMON_TOOL_UPDATES,
        pauses: DAEMON_EMISSIONS,
        inboxExcluded: true
      },
      trace: {
        handoffs: TRACE_HANDOFFS,
        totalSqlStatements: TRACE_SQL_STATEMENTS,
        logicalBatches: TRACE_LOGICAL_BATCHES,
        statementsPerBatch: TRACE_STATEMENTS_PER_BATCH
      }
    },
    executorEquivalence: { realPostgres: true, concurrentTraceCount: 2 },
    daemon,
    traces: { syncWorker, asyncSingle, asyncPool: { ...asyncPool, poolSize: settings.asyncPoolSize } },
    ratios: {
      asyncSingleOverSync: matchedRatios(asyncSingle.rungs, syncWorker.rungs),
      asyncPoolOverAsyncSingle: matchedRatios(asyncPool.rungs, asyncSingle.rungs)
    }
  }
}

describe('PostgreSQL capacity benchmark', () => {
  it('starts trace work inside measurement and counts the blocking first handoff', async () => {
    let now = 0
    let started = false
    const lateWork: Promise<unknown>[] = []
    const resultPromise = measureTraceSlot(
      () => {
        started = true
        now = 25
        return Promise.resolve('done')
      },
      100,
      lateWork,
      {
        now: () => now,
        setTimeout: () => 'timer',
        clearTimeout: () => undefined
      }
    )
    assert.equal(started, false)
    const result = await resultPromise
    assert.equal(result.status, 'completed')
    assert.equal(result.elapsedMs, 25)
    assert.equal(lateWork.length, 1)
  })

  it('continues with fresh configured rungs after a measured failure', async () => {
    const visited: number[] = []
    const rungs = await collectConfiguredRungs([1, 2, 4], async (concurrency) => {
      visited.push(concurrency)
      return { concurrency, errors: concurrency === 2 ? 1 : 0, timeouts: 0 }
    })
    assert.deepStrictEqual(visited, [1, 2, 4])
    assert.deepStrictEqual(
      rungs.map((rung) => rung.concurrency),
      [1, 2, 4]
    )
  })

  it('rejects a truncated configured ladder before writing', () => {
    const report = testReport()
    report.traces.syncWorker.rungs.pop()
    report.traces.syncWorker.capacity = deriveCapacity(report.traces.syncWorker.rungs)
    assert.throws(() => validateReport(report), /configured concurrency/)
  })

  it('rejects misaligned verification and ratio coverage before writing', () => {
    const truncatedVerification = testReport()
    truncatedVerification.daemon.verification.pop()
    assert.throws(() => validateReport(truncatedVerification), /verification/)

    const wrongOrganizationCardinality = testReport()
    wrongOrganizationCardinality.daemon.verification[1]!.resolvedOrganizationByAgent = {
      'agent-1': BENCHMARK_ORGANIZATION
    }
    assert.throws(() => validateReport(wrongOrganizationCardinality), /organization/)

    const truncatedRatios = testReport()
    truncatedRatios.ratios.asyncSingleOverSync.pop()
    assert.throws(() => validateReport(truncatedRatios), /ratio/)

    const reorderedRatios = testReport()
    reorderedRatios.ratios.asyncPoolOverAsyncSingle.reverse()
    assert.throws(() => validateReport(reorderedRatios), /ratio/)

    const invalidRatio = testReport()
    invalidRatio.ratios.asyncSingleOverSync[0]!.throughputSpeedup = Number.NaN
    assert.throws(() => validateReport(invalidRatio), /ratio/)
  })

  it('rejects incomplete partial-rung persistence before writing', () => {
    const report = testReport()
    Object.assign(report.daemon.rungs[0]!, { completed: 50, errors: 50 })
    report.daemon.capacity = deriveCapacity(report.daemon.rungs)
    report.daemon.verification[0]!.completedOutputs = 49
    assert.throws(() => validateReport(report), /completed outputs/)
  })

  it('rejects negative and stale matched-rung ratios before writing', () => {
    const negative = testReport()
    negative.ratios.asyncSingleOverSync[0]!.throughputSpeedup = -1
    assert.throws(() => validateReport(negative), /ratio/)

    const stale = testReport()
    stale.ratios.asyncPoolOverAsyncSingle[0]!.p95LatencyRatio = 2
    assert.throws(() => validateReport(stale), /ratio/)
  })

  it('rejects invalid report provenance and executor declarations before writing', () => {
    const emptyWarning = testReport()
    emptyWarning.warning = ''
    assert.throws(() => validateReport(emptyWarning), /warning/)

    const missingCpu = testReport()
    missingCpu.environment.cpu.count = 0
    assert.throws(() => validateReport(missingCpu), /environment/)

    const falseEquivalence = testReport()
    falseEquivalence.executorEquivalence.realPostgres = false as true
    assert.throws(() => validateReport(falseEquivalence), /executor equivalence/)

    const wrongPoolSize = testReport()
    wrongPoolSize.traces.asyncPool.poolSize += 1
    assert.throws(() => validateReport(wrongPoolSize), /pool size/)
  })

  it('rejects a report without the exact synthetic trace workload shape', () => {
    const report = testReport()
    delete (report.workload.trace as Partial<typeof report.workload.trace>).totalSqlStatements
    assert.throws(() => validateReport(report), /trace workload/)
  })

  it('emits one validated real-cluster capacity report', async () => {
    const databaseUrl = inject('postgresCapacityDatabaseUrl')
    const settings = parseCapacitySettings(process.env)
    await resetBenchmarkDatabase(databaseUrl)
    const contract = await runPostgresTraceContract(databaseUrl, {
      asyncPoolSize: settings.asyncPoolSize,
      concurrentTraceCount: 2
    })
    for (const run of [contract.sync, contract.asyncSingle, contract.asyncPool]) {
      assert.equal(run.traceResults.length, 2)
      assert.equal(
        run.traceResults.every((trace) => trace.length === TRACE_HANDOFFS),
        true
      )
    }
    const daemon = await runDaemonLadder(databaseUrl, settings)
    const syncWorker = await runTraceLadder(databaseUrl, settings, 'sync-worker', () =>
      SyncWorkerTraceExecutor.open(databaseUrl)
    )
    const asyncSingle = await runTraceLadder(
      databaseUrl,
      settings,
      'async-single',
      () => new AsyncTraceExecutor(databaseUrl, 1)
    )
    const asyncPool = await runTraceLadder(
      databaseUrl,
      settings,
      'async-pool',
      () => new AsyncTraceExecutor(databaseUrl, settings.asyncPoolSize)
    )
    const cpu = cpus()
    const report: CapacityReport = {
      schemaVersion: 1,
      warning: 'Synthetic benchmark: results describe only this declared workload and environment.',
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: { model: cpu[0]?.model ?? 'unknown', count: cpu.length },
        postgres: {
          image: inject('postgresCapacityImage'),
          version: inject('postgresCapacityVersion')
        }
      },
      settings,
      workload: {
        daemon: {
          emissions: DAEMON_EMISSIONS,
          reasoning: 1,
          tools: DAEMON_TOOLS,
          updatesPerTool: DAEMON_TOOL_UPDATES,
          pauses: DAEMON_EMISSIONS,
          inboxExcluded: true
        },
        trace: {
          handoffs: TRACE_HANDOFFS,
          totalSqlStatements: TRACE_SQL_STATEMENTS,
          logicalBatches: TRACE_LOGICAL_BATCHES,
          statementsPerBatch: TRACE_STATEMENTS_PER_BATCH
        }
      },
      executorEquivalence: { realPostgres: true, concurrentTraceCount: 2 },
      daemon,
      traces: {
        syncWorker,
        asyncSingle,
        asyncPool: { ...asyncPool, poolSize: settings.asyncPoolSize }
      },
      ratios: {
        asyncSingleOverSync: matchedRatios(asyncSingle.rungs, syncWorker.rungs),
        asyncPoolOverAsyncSingle: matchedRatios(asyncPool.rungs, asyncSingle.rungs)
      }
    }
    const written: string[] = []
    emitReport(report, (line) => written.push(line))
    assert.equal(written.length, 1)
    assert.deepStrictEqual(JSON.parse(written[0]!), report)
    console.log(written[0])
  })
})
