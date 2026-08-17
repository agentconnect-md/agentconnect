/**
 * Frozen copy of `PostgresSyncDatabase`, the worker bridge the async store replaced.
 *
 * It lives under `test/performance/` and is loaded only by the capacity benchmark's
 * `sync-worker` rung, which exists to measure the blocking bridge against the async pool.
 * Production code no longer contains an `Atomics.wait`; do not import this from `src/`.
 */
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import type { DataPlaneConfig } from '../../src/store/postgres-config.js'
import { POOL_STORE_SCHEMA } from '../../src/store/postgres-dialect.js'
import type { StoreBatchResult, StoreBatchStatement } from '../../src/store/store-database.js'

type WorkerReply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: string }

/** The synchronous store seam this bridge was written against; the live seam is async now. */
interface StoreRunResult {
  changes: number | bigint
}

interface StoreStatement {
  run(...params: unknown[]): StoreRunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface StoreDatabase {
  exec(sql: string): void
  prepare(sql: string): StoreStatement
  batch(statements: StoreBatchStatement[]): StoreBatchResult[]
  close(): void
}

class PostgresStatement implements StoreStatement {
  constructor(
    private readonly database: FrozenSyncDatabase,
    private readonly sql: string
  ) {}

  run(...params: unknown[]): StoreRunResult {
    const result = this.database.query(this.sql, params)
    return { changes: result.changes }
  }

  get(...params: unknown[]): unknown {
    return this.database.query(this.sql, params).rows[0]
  }

  all(...params: unknown[]): unknown[] {
    return this.database.query(this.sql, params).rows
  }
}

/** Synchronous facade over a dedicated PostgreSQL worker, preserving LocalStore's commit-before-return contract. */
export class FrozenSyncDatabase implements StoreDatabase {
  private readonly worker: Worker
  private readonly replies
  private nextId = 1
  private closed = false

  constructor(
    config: DataPlaneConfig,
    private readonly onFailure: (error: Error) => void = () => undefined
  ) {
    const channel = new MessageChannel()
    const readySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    this.replies = channel.port1
    this.worker = new Worker(new URL('./frozen-sync-store-worker.js', import.meta.url), {
      workerData: {
        databaseUrl: config.databaseUrl,
        schema: POOL_STORE_SCHEMA,
        replyPort: channel.port2,
        readySignal
      },
      transferList: [channel.port2]
    })
    if (Atomics.wait(readySignal, 0, 0, 30_000) === 'timed-out') {
      void this.worker.terminate()
      throw new Error('PostgreSQL pool store startup timed out after 30 seconds')
    }
    const ready = this.waitForReply(0)
    if (!ready.ok) throw new Error(`PostgreSQL pool store failed to open: ${ready.error}`)
  }

  exec(sql: string): void {
    this.request('exec', sql, [])
  }

  prepare(sql: string): StoreStatement {
    return new PostgresStatement(this, sql)
  }

  query(sql: string, params: unknown[]): { rows: unknown[]; changes: number } {
    const value = this.request('query', sql, params) as { rows?: unknown[]; changes?: number } | undefined
    return { rows: value?.rows ?? [], changes: value?.changes ?? 0 }
  }

  /** One round trip for an ordered statement list. The worker still runs each statement on its
   *  own — same rewrite, same per-statement commit — so only the number of blocking hand-offs
   *  changes. An error names the statement that failed and abandons the rest, exactly as the
   *  equivalent run of single-statement calls would. */
  batch(statements: StoreBatchStatement[]): StoreBatchResult[] {
    if (statements.length === 0) return []
    const value = this.request('batch', '', [], statements) as { rows?: unknown[]; changes?: number }[] | undefined
    return (value ?? []).map((result) => ({ rows: result?.rows ?? [], changes: result?.changes ?? 0 }))
  }

  finishSchemaInitialization(): void {
    this.request('finishSchemaInitialization', '', [])
  }

  close(): void {
    if (this.closed) return
    this.request('close', '', [])
    this.closed = true
    void this.worker.terminate()
    this.replies.close()
  }

  private request(kind: string, sql: string, params: unknown[], statements?: StoreBatchStatement[]): unknown {
    if (this.closed) throw new Error('PostgreSQL pool store is closed')
    const id = this.nextId++
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    this.worker.postMessage({ id, kind, sql, params, statements, signal })
    if (Atomics.wait(signal, 0, 0, 30_000) === 'timed-out') {
      const error = new Error('PostgreSQL pool store operation timed out after 30 seconds')
      this.onFailure(error)
      throw error
    }
    const reply = this.waitForReply(id)
    if (!reply.ok) {
      const error = new Error(reply.error)
      this.onFailure(error)
      throw error
    }
    return reply.value
  }

  private waitForReply(id: number): WorkerReply {
    for (;;) {
      const received = receiveMessageOnPort(this.replies)
      if (received) {
        const reply = received.message as WorkerReply
        if (reply.id === id) return reply
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    }
  }
}
