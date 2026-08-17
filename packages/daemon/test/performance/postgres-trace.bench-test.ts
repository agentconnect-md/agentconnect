import { describe, expect, it, vi } from 'vitest'

import { resolvePrivateTraceContractSettings } from './postgres-trace-contract.bench.js'
import {
  AsyncTraceExecutor,
  SyncWorkerTraceExecutor,
  TRACE_SCHEMA,
  TRACE_STATEMENTS,
  initializeTraceSchema,
  resetTraceSchema,
  runConcurrentSyntheticTraces,
  runSyntheticTrace,
  snapshotTraceRows,
  type TraceExecutor,
  type TraceResult,
  type TraceStatement
} from './postgres-trace.js'

type RecordedCall =
  { method: 'exec' | 'query'; statement: TraceStatement } | { method: 'batch'; statements: readonly TraceStatement[] }

class FakeTraceExecutor implements TraceExecutor {
  readonly calls: RecordedCall[] = []

  async exec(statement: TraceStatement): Promise<TraceResult> {
    this.calls.push({ method: 'exec', statement })
    return { rows: [], changes: 1 }
  }

  async query(statement: TraceStatement): Promise<TraceResult> {
    this.calls.push({ method: 'query', statement })
    return { rows: [{ call: this.calls.length }], changes: 0 }
  }

  async batch(statements: readonly TraceStatement[]): Promise<readonly TraceResult[]> {
    this.calls.push({ method: 'batch', statements })
    return statements.map(() => ({ rows: [], changes: 1 }))
  }

  async close(): Promise<void> {}
}

describe('private trace contract settings', () => {
  it('accepts pool size one while requiring at least two concurrent traces', () => {
    expect(resolvePrivateTraceContractSettings({ asyncPoolSize: 1, concurrentTraceCount: 2 })).toEqual({
      asyncPoolSize: 1,
      concurrentTraceCount: 2
    })
    expect(() => resolvePrivateTraceContractSettings({ concurrentTraceCount: 1 })).toThrow(
      'concurrentTraceCount must be a safe integer of at least 2'
    )
    expect(() => resolvePrivateTraceContractSettings({ asyncPoolSize: 0 })).toThrow(
      'asyncPoolSize must be a safe integer of at least 1'
    )
  })
})

describe('runSyntheticTrace', () => {
  it('uses exactly 17 ordered executor hand-offs and preserves logical batches', async () => {
    const executor = new FakeTraceExecutor()

    const results = await runSyntheticTrace(executor, { agentId: 'agent-a', turnId: 'turn-a' })

    expect(executor.calls.map((call) => call.method)).toEqual([
      'exec',
      'query',
      'batch',
      'exec',
      'query',
      'exec',
      'batch',
      'query',
      'exec',
      'query',
      'batch',
      'query',
      'exec',
      'query',
      'batch',
      'query',
      'query'
    ])
    expect(
      executor.calls.map((call) =>
        call.method === 'batch' ? call.statements.map((statement) => statement.sql) : call.statement.sql
      )
    ).toEqual([
      TRACE_STATEMENTS.insertTurn.sql,
      TRACE_STATEMENTS.readTurn.sql,
      [TRACE_STATEMENTS.insertInput.sql, TRACE_STATEMENTS.insertPlan.sql],
      TRACE_STATEMENTS.markTurnRunning.sql,
      TRACE_STATEMENTS.readTurnRows.sql,
      TRACE_STATEMENTS.insertTool.sql,
      [TRACE_STATEMENTS.markToolDone.sql, TRACE_STATEMENTS.insertToolResult.sql],
      TRACE_STATEMENTS.readToolRows.sql,
      TRACE_STATEMENTS.bumpTurnRevision.sql,
      TRACE_STATEMENTS.readTurnRevision.sql,
      [TRACE_STATEMENTS.insertOutput.sql, TRACE_STATEMENTS.markOutputReady.sql],
      TRACE_STATEMENTS.readOutput.sql,
      TRACE_STATEMENTS.insertMemory.sql,
      TRACE_STATEMENTS.readMemory.sql,
      [TRACE_STATEMENTS.markTurnComplete.sql, TRACE_STATEMENTS.insertAudit.sql],
      TRACE_STATEMENTS.readFinalRows.sql,
      TRACE_STATEMENTS.readSummary.sql
    ])
    expect(results).toHaveLength(17)
    expect(executor.calls.filter((call) => call.method === 'batch').map((call) => call.statements.length)).toEqual([
      2, 2, 2, 2
    ])
  })

  it('runs the identical injected yield boundary after every hand-off', async () => {
    const timeline: string[] = []
    const executor = new FakeTraceExecutor()
    const methods = ['exec', 'query', 'batch'] as const
    for (const method of methods) {
      const original = executor[method].bind(executor) as (...args: never[]) => Promise<unknown>
      executor[method] = (async (...args: never[]) => {
        timeline.push(`call:${executor.calls.length + 1}`)
        return original(...args)
      }) as never
    }
    const yieldAfterHandoff = vi.fn(async () => {
      timeline.push(`yield:${executor.calls.length}`)
    })

    await runSyntheticTrace(executor, { agentId: 'agent-a', turnId: 'turn-a' }, yieldAfterHandoff)

    expect(yieldAfterHandoff).toHaveBeenCalledTimes(17)
    expect(timeline).toEqual(
      Array.from({ length: 17 }, (_, index) => [`call:${index + 1}`, `yield:${index + 1}`]).flat()
    )
  })

  it('names every inserted logical row uniquely for each turn', async () => {
    const first = new FakeTraceExecutor()
    const second = new FakeTraceExecutor()

    await runSyntheticTrace(first, { agentId: 'agent-a', turnId: 'turn-a' })
    await runSyntheticTrace(second, { agentId: 'agent-a', turnId: 'turn-b' })

    const insertedIds = (executor: FakeTraceExecutor) =>
      executor.calls.flatMap((call) => {
        const statements = call.method === 'batch' ? call.statements : [call.statement]
        return statements
          .filter((statement) => /^INSERT\s/i.test(statement.sql))
          .map((statement) => statement.params[0])
      })
    const firstIds = insertedIds(first)
    const secondIds = insertedIds(second)
    expect(new Set(firstIds).size).toBe(firstIds.length)
    expect(new Set(secondIds).size).toBe(secondIds.length)
    expect(firstIds.every((id) => String(id).includes('turn-a'))).toBe(true)
    expect(secondIds.every((id) => String(id).includes('turn-b'))).toBe(true)
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([])
  })

  it('keeps canonical trace SQL private, qualified, and in question-mark form', () => {
    const statements = Object.values(TRACE_STATEMENTS).flatMap((statement) =>
      Array.isArray(statement) ? statement : [statement]
    )
    expect(TRACE_SCHEMA).toBe('agentconnect_capacity_bench')
    expect(statements.length).toBeGreaterThan(17)
    for (const statement of statements) {
      expect(statement.sql).toContain(`${TRACE_SCHEMA}.`)
      expect(statement.sql).not.toMatch(/\$\d+/)
    }
  })
})

describe('runConcurrentSyntheticTraces', () => {
  it('starts distinct traces concurrently and returns each complete 17-handoff result', async () => {
    let activeStarts = 0
    let maximumActiveStarts = 0
    const executor = new FakeTraceExecutor()
    const originalExec = executor.exec.bind(executor)
    executor.exec = async (statement) => {
      if (statement.sql === TRACE_STATEMENTS.insertTurn.sql) {
        activeStarts += 1
        maximumActiveStarts = Math.max(maximumActiveStarts, activeStarts)
        await Promise.resolve()
        activeStarts -= 1
      }
      return originalExec(statement)
    }

    const results = await runConcurrentSyntheticTraces(executor, [
      { agentId: 'agent-a', turnId: 'turn-a' },
      { agentId: 'agent-a', turnId: 'turn-b' }
    ])

    expect(maximumActiveStarts).toBe(2)
    expect(results).toHaveLength(2)
    expect(results.map((trace) => trace.length)).toEqual([17, 17])
    expect(executor.calls).toHaveLength(34)
  })

  it('requires at least two trace identities', async () => {
    await expect(
      runConcurrentSyntheticTraces(new FakeTraceExecutor(), [{ agentId: 'agent-a', turnId: 'turn-a' }])
    ).rejects.toThrow('at least two')
  })

  it('waits for sibling traces to settle before reporting a failure', async () => {
    let releaseSibling!: () => void
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve
    })
    const executor = new FakeTraceExecutor()
    const originalExec = executor.exec.bind(executor)
    executor.exec = async (statement) => {
      if (statement.sql === TRACE_STATEMENTS.insertTurn.sql && statement.params[1] === 'turn-a') {
        throw new Error('turn-a failed')
      }
      if (statement.sql === TRACE_STATEMENTS.insertTurn.sql && statement.params[1] === 'turn-b') await siblingGate
      return originalExec(statement)
    }
    let settled = false
    const execution = runConcurrentSyntheticTraces(executor, [
      { agentId: 'agent-a', turnId: 'turn-a' },
      { agentId: 'agent-a', turnId: 'turn-b' }
    ]).finally(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseSibling()
    await expect(execution).rejects.toThrow('turn-a failed')
    expect(executor.calls).toHaveLength(17)
  })
})

describe('benchmark schema helpers', () => {
  it('initializes, resets, and snapshots benchmark-owned rows explicitly', async () => {
    const executor = new FakeTraceExecutor()

    await initializeTraceSchema(executor)
    await resetTraceSchema(executor)
    const snapshot = await snapshotTraceRows(executor)

    expect(executor.calls.map((call) => call.method)).toEqual(['batch', 'exec', 'query'])
    expect(executor.calls[0]).toMatchObject({ method: 'batch' })
    const resetCall = executor.calls[1]
    const snapshotCall = executor.calls[2]
    if (!resetCall || resetCall.method !== 'exec') throw new Error('expected reset exec call')
    if (!snapshotCall || snapshotCall.method !== 'query') throw new Error('expected snapshot query call')
    expect(resetCall.statement.sql).toContain(`TRUNCATE ${TRACE_SCHEMA}.trace_rows`)
    expect(snapshotCall.statement.sql).toContain(`FROM ${TRACE_SCHEMA}.trace_rows`)
    expect(snapshot).toEqual([{ call: 3 }])
  })
})

describe('SyncWorkerTraceExecutor', () => {
  it('finishes worker schema initialization before normal operations and closes it', async () => {
    const timeline: string[] = []
    const database = {
      finishSchemaInitialization: vi.fn(() => timeline.push('finish')),
      exec: vi.fn(() => timeline.push('exec')),
      query: vi.fn(() => {
        timeline.push('query')
        return { rows: [{ value: 1 }], changes: 1 }
      }),
      batch: vi.fn(() => {
        timeline.push('batch')
        return [{ rows: [], changes: 2 }]
      }),
      close: vi.fn(() => timeline.push('close'))
    }

    const executor = new SyncWorkerTraceExecutor(database)
    await executor.exec({ sql: 'SELECT 1', params: [] })
    await expect(executor.query({ sql: 'SELECT ?', params: [1] })).resolves.toEqual({
      rows: [{ value: 1 }],
      changes: 1
    })
    await expect(executor.batch([{ sql: 'UPDATE x SET y = ?', params: [1] }])).resolves.toEqual([
      { rows: [], changes: 2 }
    ])
    await executor.close()

    expect(timeline).toEqual(['finish', 'exec', 'query', 'batch', 'close'])
  })

  it('binds parameterized exec statements through the synchronous query operation', async () => {
    const database = {
      finishSchemaInitialization: vi.fn(),
      exec: vi.fn(),
      query: vi.fn(() => ({ rows: [], changes: 1 })),
      batch: vi.fn(),
      close: vi.fn()
    }
    const executor = new SyncWorkerTraceExecutor(database)

    await expect(executor.exec({ sql: 'INSERT INTO private.rows VALUES (?, ?)', params: ['a', 1] })).resolves.toEqual({
      rows: [],
      changes: 1
    })

    expect(database.query).toHaveBeenCalledWith('INSERT INTO private.rows VALUES (?, ?)', ['a', 1])
    expect(database.exec).not.toHaveBeenCalled()
  })
})

describe('AsyncTraceExecutor', () => {
  it('configures pg.Pool size and safely converts placeholders outside quoted text', async () => {
    const query = vi.fn(async () => ({ rows: [{ value: 'x' }], rowCount: 1 }))
    const end = vi.fn(async () => undefined)
    const poolFactory = vi.fn(() => ({ query, connect: vi.fn(), end }))
    const executor = new AsyncTraceExecutor('postgres://benchmark', 3, poolFactory)

    await expect(
      executor.query({
        sql: `SELECT '?' AS literal, ?::text AS value, 'it''s ?' AS other, $$?$$ AS dollar /* ? */ -- ?\n`,
        params: ['x']
      })
    ).resolves.toEqual({ rows: [{ value: 'x' }], changes: 1 })
    await executor.close()

    expect(poolFactory).toHaveBeenCalledWith({
      connectionString: 'postgres://benchmark',
      max: 3,
      application_name: 'agentconnect-capacity-bench'
    })
    expect(query).toHaveBeenCalledWith(
      `SELECT '?' AS literal, $1::text AS value, 'it''s ?' AS other, $$?$$ AS dollar /* ? */ -- ?\n`,
      ['x']
    )
    expect(end).toHaveBeenCalledOnce()
  })

  it('preserves question marks inside PostgreSQL escape strings', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => ({
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined)
    }))
    const sql = String.raw`SELECT E'it\'s ?' AS escaped, ?::text AS value`

    await executor.query({ sql, params: ['x'] })

    expect(query).toHaveBeenCalledWith(String.raw`SELECT E'it\'s ?' AS escaped, $1::text AS value`, ['x'])
  })

  it('preserves question marks inside nested block comments', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => ({
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined)
    }))
    const sql = 'SELECT value FROM rows WHERE value = /* outer ? /* inner ? */ outer again ? */ ?::text'

    await executor.query({ sql, params: ['x'] })

    expect(query).toHaveBeenCalledWith(
      'SELECT value FROM rows WHERE value = /* outer ? /* inner ? */ outer again ? */ $1::text',
      ['x']
    )
  })

  it('preserves PostgreSQL JSON existence operators while converting placeholders', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => ({
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined)
    }))
    const sql =
      `SELECT payload ? 'key', payload ?| array['a'], payload ?& array['b'] ` +
      'FROM agentconnect_capacity_bench.trace_rows WHERE row_id = ?'

    await executor.query({ sql, params: ['turn:row'] })

    expect(query).toHaveBeenCalledWith(
      `SELECT payload ? 'key', payload ?| array['a'], payload ?& array['b'] ` +
        'FROM agentconnect_capacity_bench.trace_rows WHERE row_id = $1',
      ['turn:row']
    )
  })

  it('uses one acquired client for a whole batch and releases it after sequential autocommit queries', async () => {
    const timeline: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        timeline.push(sql)
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(() => timeline.push('release'))
    }
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined)
    }
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => pool)

    await expect(
      executor.batch([
        { sql: 'INSERT INTO x VALUES (?)', params: ['a'] },
        { sql: 'UPDATE x SET y = ? WHERE z = ?', params: ['b', 'a'] }
      ])
    ).resolves.toEqual([
      { rows: [], changes: 1 },
      { rows: [], changes: 1 }
    ])

    expect(pool.connect).toHaveBeenCalledOnce()
    expect(timeline).toEqual(['INSERT INTO x VALUES ($1)', 'UPDATE x SET y = $1 WHERE z = $2', 'release'])
  })

  it('releases the batch client when a statement fails', async () => {
    const error = new Error('statement failed')
    const client = {
      query: vi.fn().mockRejectedValue(error),
      release: vi.fn()
    }
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => ({
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined)
    }))

    await expect(executor.batch([{ sql: 'SELECT 1 WHERE value = ?', params: [1] }])).rejects.toBe(error)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rejects ambiguous placeholder syntax before sending a query', async () => {
    const query = vi.fn()
    const executor = new AsyncTraceExecutor('postgres://benchmark', 1, () => ({
      query,
      connect: vi.fn(),
      end: vi.fn(async () => undefined)
    }))

    await expect(executor.query({ sql: 'SELECT ?', params: [1] })).rejects.toThrow(
      'statement has 0 placeholders but 1 parameters'
    )
    expect(query).not.toHaveBeenCalled()
  })
})
