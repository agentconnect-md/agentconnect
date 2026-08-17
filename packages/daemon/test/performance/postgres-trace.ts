import { Pool } from 'pg'

import { PostgresSyncDatabase } from '../../src/store/postgres-sync-database.js'

export const TRACE_SCHEMA = 'agentconnect_capacity_bench'

export interface TraceStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

export type NormalizedTraceValue = null | boolean | number | string
export type NormalizedTraceRow = Record<string, NormalizedTraceValue>

export interface TraceResult {
  readonly rows: readonly NormalizedTraceRow[]
  readonly changes: number
}

export interface TraceExecutor {
  exec(statement: TraceStatement): Promise<TraceResult>
  query(statement: TraceStatement): Promise<TraceResult>
  batch(statements: readonly TraceStatement[]): Promise<readonly TraceResult[]>
  close(): Promise<void>
}

export type TraceHandoffResult = TraceResult | readonly TraceResult[]

export interface SyntheticTraceIdentity {
  readonly agentId: string
  readonly turnId: string
}

const statement = (sql: string): TraceStatement => ({ sql, params: [] })

export const TRACE_STATEMENTS = {
  insertTurn: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  readTurn: statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE row_id = ?`),
  insertInput: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  insertPlan: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  markTurnRunning: statement(
    `UPDATE ${TRACE_SCHEMA}.trace_rows SET state = ?, revision = revision + 1 WHERE row_id = ?`
  ),
  readTurnRows: statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE turn_id = ? ORDER BY ordinal, row_id`),
  insertTool: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  markToolDone: statement(`UPDATE ${TRACE_SCHEMA}.trace_rows SET state = ?, revision = revision + 1 WHERE row_id = ?`),
  insertToolResult: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  readToolRows: statement(
    `SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE turn_id = ? AND row_kind IN (?, ?) ORDER BY ordinal, row_id`
  ),
  bumpTurnRevision: statement(`UPDATE ${TRACE_SCHEMA}.trace_rows SET revision = revision + 1 WHERE row_id = ?`),
  readTurnRevision: statement(`SELECT row_id, state, revision FROM ${TRACE_SCHEMA}.trace_rows WHERE row_id = ?`),
  insertOutput: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  markOutputReady: statement(
    `UPDATE ${TRACE_SCHEMA}.trace_rows SET state = ?, revision = revision + 1 WHERE row_id = ?`
  ),
  readOutput: statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE row_id = ?`),
  insertMemory: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  readMemory: statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE row_id = ?`),
  markTurnComplete: statement(
    `UPDATE ${TRACE_SCHEMA}.trace_rows SET state = ?, revision = revision + 1 WHERE row_id = ?`
  ),
  insertAudit: statement(
    `INSERT INTO ${TRACE_SCHEMA}.trace_rows (row_id, turn_id, agent_id, row_kind, ordinal, state, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  readFinalRows: statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows WHERE turn_id = ? ORDER BY ordinal, row_id`),
  readSummary: statement(
    `SELECT turn_id, COUNT(*)::int AS row_count, SUM(revision)::int AS revision_total FROM ${TRACE_SCHEMA}.trace_rows WHERE turn_id = ? GROUP BY turn_id`
  )
} as const

const INITIALIZE_STATEMENTS: readonly TraceStatement[] = [
  statement(`CREATE SCHEMA IF NOT EXISTS ${TRACE_SCHEMA}`),
  statement(
    `CREATE TABLE IF NOT EXISTS ${TRACE_SCHEMA}.trace_rows (` +
      'row_id TEXT PRIMARY KEY, ' +
      'turn_id TEXT NOT NULL, ' +
      'agent_id TEXT NOT NULL, ' +
      'row_kind TEXT NOT NULL, ' +
      'ordinal INT NOT NULL, ' +
      'state TEXT NOT NULL, ' +
      'payload TEXT NOT NULL, ' +
      'revision INT NOT NULL)'
  )
]

const withParams = (template: TraceStatement, ...params: unknown[]): TraceStatement => ({
  sql: template.sql,
  params
})

const insertParams = (
  rowId: string,
  turnId: string,
  agentId: string,
  rowKind: string,
  ordinal: number,
  state: string,
  payload: string
): readonly unknown[] => [rowId, turnId, agentId, rowKind, ordinal, state, payload, 0]

export async function runSyntheticTrace(
  executor: TraceExecutor,
  identity: SyntheticTraceIdentity,
  yieldAfterHandoff: () => Promise<void> = async () => undefined
): Promise<readonly TraceHandoffResult[]> {
  const { agentId, turnId } = identity
  const rowId = (kind: string) => `${turnId}:${kind}`
  const handoffs: Array<() => Promise<TraceHandoffResult>> = [
    () =>
      executor.exec(
        withParams(
          TRACE_STATEMENTS.insertTurn,
          ...insertParams(rowId('turn'), turnId, agentId, 'turn', 0, 'queued', '{}')
        )
      ),
    () => executor.query(withParams(TRACE_STATEMENTS.readTurn, rowId('turn'))),
    () =>
      executor.batch([
        withParams(
          TRACE_STATEMENTS.insertInput,
          ...insertParams(rowId('input'), turnId, agentId, 'input', 10, 'stored', '{"text":"hello"}')
        ),
        withParams(
          TRACE_STATEMENTS.insertPlan,
          ...insertParams(rowId('plan'), turnId, agentId, 'plan', 20, 'stored', '{"steps":2}')
        )
      ]),
    () => executor.exec(withParams(TRACE_STATEMENTS.markTurnRunning, 'running', rowId('turn'))),
    () => executor.query(withParams(TRACE_STATEMENTS.readTurnRows, turnId)),
    () =>
      executor.exec(
        withParams(
          TRACE_STATEMENTS.insertTool,
          ...insertParams(rowId('tool'), turnId, agentId, 'tool', 30, 'started', '{"name":"read"}')
        )
      ),
    () =>
      executor.batch([
        withParams(TRACE_STATEMENTS.markToolDone, 'completed', rowId('tool')),
        withParams(
          TRACE_STATEMENTS.insertToolResult,
          ...insertParams(rowId('tool-result'), turnId, agentId, 'tool-result', 40, 'stored', '{"bytes":12}')
        )
      ]),
    () => executor.query(withParams(TRACE_STATEMENTS.readToolRows, turnId, 'tool', 'tool-result')),
    () => executor.exec(withParams(TRACE_STATEMENTS.bumpTurnRevision, rowId('turn'))),
    () => executor.query(withParams(TRACE_STATEMENTS.readTurnRevision, rowId('turn'))),
    () =>
      executor.batch([
        withParams(
          TRACE_STATEMENTS.insertOutput,
          ...insertParams(rowId('output'), turnId, agentId, 'output', 50, 'stored', '{"text":"done"}')
        ),
        withParams(TRACE_STATEMENTS.markOutputReady, 'output-ready', rowId('turn'))
      ]),
    () => executor.query(withParams(TRACE_STATEMENTS.readOutput, rowId('output'))),
    () =>
      executor.exec(
        withParams(
          TRACE_STATEMENTS.insertMemory,
          ...insertParams(rowId('memory'), turnId, agentId, 'memory', 60, 'stored', '{"remember":true}')
        )
      ),
    () => executor.query(withParams(TRACE_STATEMENTS.readMemory, rowId('memory'))),
    () =>
      executor.batch([
        withParams(TRACE_STATEMENTS.markTurnComplete, 'completed', rowId('turn')),
        withParams(
          TRACE_STATEMENTS.insertAudit,
          ...insertParams(rowId('audit'), turnId, agentId, 'audit', 70, 'stored', '{"final":true}')
        )
      ]),
    () => executor.query(withParams(TRACE_STATEMENTS.readFinalRows, turnId)),
    () => executor.query(withParams(TRACE_STATEMENTS.readSummary, turnId))
  ]
  const results: TraceHandoffResult[] = []
  for (const handoff of handoffs) {
    results.push(await handoff())
    await yieldAfterHandoff()
  }
  return results
}

export async function runConcurrentSyntheticTraces(
  executor: TraceExecutor,
  identities: readonly SyntheticTraceIdentity[],
  yieldAfterHandoff?: () => Promise<void>
): Promise<readonly (readonly TraceHandoffResult[])[]> {
  if (identities.length < 2) throw new Error('concurrent synthetic trace requires at least two identities')
  const settled = await Promise.allSettled(
    identities.map((identity) => runSyntheticTrace(executor, identity, yieldAfterHandoff))
  )
  const results: Array<readonly TraceHandoffResult[]> = []
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason
    results.push(result.value)
  }
  return results
}

export async function initializeTraceSchema(executor: TraceExecutor): Promise<void> {
  await executor.batch(INITIALIZE_STATEMENTS)
}

export async function resetTraceSchema(executor: TraceExecutor): Promise<void> {
  await executor.exec(statement(`TRUNCATE ${TRACE_SCHEMA}.trace_rows`))
}

export async function snapshotTraceRows(executor: TraceExecutor): Promise<readonly NormalizedTraceRow[]> {
  const result = await executor.query(
    statement(`SELECT * FROM ${TRACE_SCHEMA}.trace_rows ORDER BY turn_id, ordinal, row_id`)
  )
  return result.rows
}

interface SyncDatabase {
  exec(sql: string): void
  query(sql: string, params: unknown[]): { rows: unknown[]; changes: number }
  batch(statements: Array<{ sql: string; params: unknown[] }>): Array<{ rows: unknown[]; changes: number }>
  finishSchemaInitialization(): void
  close(): void
}

function normalizeValue(value: unknown): NormalizedTraceValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return value
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

function normalizeResult(result: {
  rows?: readonly unknown[]
  changes?: number
  rowCount?: number | null
}): TraceResult {
  return {
    rows: (result.rows ?? []).map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return { value: normalizeValue(row) }
      return Object.fromEntries(
        Object.entries(row)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, normalizeValue(value)])
      )
    }),
    changes: result.changes ?? result.rowCount ?? 0
  }
}

export class SyncWorkerTraceExecutor implements TraceExecutor {
  private initializationFinished = false

  constructor(private readonly database: SyncDatabase) {
    try {
      this.finishSchemaInitialization()
    } catch (error) {
      database.close()
      throw error
    }
  }

  static open(databaseUrl: string): SyncWorkerTraceExecutor {
    return new SyncWorkerTraceExecutor(new PostgresSyncDatabase({ version: 1, databaseUrl, maxConnections: 1 }))
  }

  finishSchemaInitialization(): void {
    if (this.initializationFinished) return
    this.database.finishSchemaInitialization()
    this.initializationFinished = true
  }

  async exec(statementToRun: TraceStatement): Promise<TraceResult> {
    if (statementToRun.params.length > 0) {
      return normalizeResult(this.database.query(statementToRun.sql, [...statementToRun.params]))
    }
    this.database.exec(statementToRun.sql)
    return { rows: [], changes: 0 }
  }

  async query(statementToRun: TraceStatement): Promise<TraceResult> {
    return normalizeResult(this.database.query(statementToRun.sql, [...statementToRun.params]))
  }

  async batch(statements: readonly TraceStatement[]): Promise<readonly TraceResult[]> {
    return this.database
      .batch(statements.map((item) => ({ sql: item.sql, params: [...item.params] })))
      .map(normalizeResult)
  }

  async close(): Promise<void> {
    this.database.close()
  }
}

interface PoolQueryResult {
  readonly rows?: readonly unknown[]
  readonly rowCount?: number | null
}

interface PoolClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<PoolQueryResult>
  release(): void
}

interface PoolLike {
  query(sql: string, params?: readonly unknown[]): Promise<PoolQueryResult>
  connect(): Promise<PoolClientLike>
  end(): Promise<void>
}

type PoolFactory = (options: { connectionString: string; max: number; application_name: string }) => PoolLike

function convertPlaceholders(sql: string, parameterCount: number): string {
  let output = ''
  let index = 0
  let state: 'normal' | 'single' | 'double' | 'line-comment' | 'block-comment' | 'dollar' = 'normal'
  let dollarTag = ''
  let escapeString = false
  let blockCommentDepth = 0
  let lastNormalSignificant: string | undefined
  for (let cursor = 0; cursor < sql.length; cursor += 1) {
    const char = sql[cursor]!
    const next = sql[cursor + 1]
    if (state === 'line-comment') {
      output += char
      if (char === '\n') state = 'normal'
      continue
    }
    if (state === 'block-comment') {
      output += char
      if (char === '/' && next === '*') {
        output += next
        cursor += 1
        blockCommentDepth += 1
      } else if (char === '*' && next === '/') {
        output += next
        cursor += 1
        blockCommentDepth -= 1
        if (blockCommentDepth === 0) state = 'normal'
      }
      continue
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, cursor)) {
        output += dollarTag
        cursor += dollarTag.length - 1
        state = 'normal'
        lastNormalSignificant = '$'
      } else output += char
      continue
    }
    if (state === 'single' || state === 'double') {
      output += char
      const quote = state === 'single' ? "'" : '"'
      if (state === 'single' && escapeString && char === '\\' && next !== undefined) {
        output += next
        cursor += 1
      } else if (char === quote && next === quote) {
        output += next
        cursor += 1
      } else if (char === quote) {
        state = 'normal'
        escapeString = false
        lastNormalSignificant = quote
      }
      continue
    }
    if (char === '-' && next === '-') {
      output += '--'
      cursor += 1
      state = 'line-comment'
    } else if (char === '/' && next === '*') {
      output += '/*'
      cursor += 1
      state = 'block-comment'
      blockCommentDepth = 1
    } else if (char === "'") {
      output += char
      state = 'single'
      const prefix = sql[cursor - 1]
      const beforePrefix = sql[cursor - 2]
      escapeString =
        (prefix === 'E' || prefix === 'e') && (beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix))
    } else if (char === '"') {
      output += char
      state = 'double'
    } else if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(cursor))
      if (match) {
        dollarTag = match[0]
        output += dollarTag
        cursor += dollarTag.length - 1
        state = 'dollar'
      } else output += char
    } else if (char === '?' && next !== '|' && next !== '&' && isCanonicalPlaceholder(lastNormalSignificant)) {
      index += 1
      output += `$${index}`
      lastNormalSignificant = '?'
    } else {
      output += char
      if (!/\s/.test(char)) lastNormalSignificant = char
    }
  }
  if (index !== parameterCount) throw new Error(`statement has ${index} placeholders but ${parameterCount} parameters`)
  return output
}

function isCanonicalPlaceholder(previous: string | undefined): boolean {
  return previous === '=' || previous === ',' || previous === '('
}

export class AsyncTraceExecutor implements TraceExecutor {
  private readonly pool: PoolLike

  constructor(databaseUrl: string, poolSize: number, poolFactory: PoolFactory = (options) => new Pool(options)) {
    this.pool = poolFactory({
      connectionString: databaseUrl,
      max: poolSize,
      application_name: 'agentconnect-capacity-bench'
    })
  }

  async exec(statementToRun: TraceStatement): Promise<TraceResult> {
    return this.run(this.pool, statementToRun)
  }

  async query(statementToRun: TraceStatement): Promise<TraceResult> {
    return this.run(this.pool, statementToRun)
  }

  async batch(statements: readonly TraceStatement[]): Promise<readonly TraceResult[]> {
    const client = await this.pool.connect()
    try {
      const results: TraceResult[] = []
      for (const statementToRun of statements) results.push(await this.run(client, statementToRun))
      return results
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async run(target: Pick<PoolLike, 'query'>, statementToRun: TraceStatement): Promise<TraceResult> {
    const sql = convertPlaceholders(statementToRun.sql, statementToRun.params.length)
    return normalizeResult(await target.query(sql, statementToRun.params))
  }
}
