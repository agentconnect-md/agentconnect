import assert from 'node:assert/strict'

import {
  AsyncTraceExecutor,
  SyncWorkerTraceExecutor,
  initializeTraceSchema,
  resetTraceSchema,
  runConcurrentSyntheticTraces,
  snapshotTraceRows,
  type NormalizedTraceRow,
  type SyntheticTraceIdentity,
  type TraceExecutor,
  type TraceHandoffResult
} from './postgres-trace.js'

export interface PostgresTraceContractOptions {
  readonly asyncPoolSize?: number
  readonly concurrentTraceCount?: number
  readonly agentId?: string
  readonly turnId?: string
}

export interface PostgresTraceContractResult {
  readonly sync: PrivateTraceContractRun
  readonly asyncSingle: PrivateTraceContractRun
  readonly asyncPool: PrivateTraceContractRun
}

export interface PrivateTraceContractRun {
  readonly traceResults: readonly (readonly TraceHandoffResult[])[]
  readonly rows: readonly NormalizedTraceRow[]
}

async function executePrivateTracesFromCleanSchema(
  executor: TraceExecutor,
  identities: readonly SyntheticTraceIdentity[]
): Promise<PrivateTraceContractRun> {
  let initialized = false
  try {
    await initializeTraceSchema(executor)
    initialized = true
    await resetTraceSchema(executor)
    const traceResults = await runConcurrentSyntheticTraces(executor, identities)
    const rows = await snapshotTraceRows(executor)
    return { traceResults, rows }
  } finally {
    try {
      if (initialized) await resetTraceSchema(executor)
    } finally {
      await executor.close()
    }
  }
}

function comparePrivateTraceRun(expected: PrivateTraceContractRun, actual: PrivateTraceContractRun): void {
  assert.deepStrictEqual(actual.traceResults, expected.traceResults)
  assert.deepStrictEqual(actual.rows, expected.rows)
}

function requireMinimum(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`)
  }
  return value
}

export function resolvePrivateTraceContractSettings(options: PostgresTraceContractOptions): {
  readonly asyncPoolSize: number
  readonly concurrentTraceCount: number
} {
  return {
    asyncPoolSize: requireMinimum(options.asyncPoolSize ?? 4, 'asyncPoolSize', 1),
    concurrentTraceCount: requireMinimum(options.concurrentTraceCount ?? 2, 'concurrentTraceCount', 2)
  }
}

export async function runPostgresTraceContract(
  databaseUrl: string,
  options: PostgresTraceContractOptions = {}
): Promise<PostgresTraceContractResult> {
  const { asyncPoolSize, concurrentTraceCount } = resolvePrivateTraceContractSettings(options)
  const agentId = options.agentId ?? 'contract-agent'
  const turnId = options.turnId ?? 'contract-turn'
  const identities = Array.from({ length: concurrentTraceCount }, (_, index) => ({
    agentId,
    turnId: `${turnId}-${index + 1}`
  }))
  const sync = await executePrivateTracesFromCleanSchema(SyncWorkerTraceExecutor.open(databaseUrl), identities)
  const asyncSingle = await executePrivateTracesFromCleanSchema(new AsyncTraceExecutor(databaseUrl, 1), identities)
  comparePrivateTraceRun(sync, asyncSingle)
  const asyncPool = await executePrivateTracesFromCleanSchema(
    new AsyncTraceExecutor(databaseUrl, asyncPoolSize),
    identities
  )
  comparePrivateTraceRun(sync, asyncPool)
  return { sync, asyncSingle, asyncPool }
}
