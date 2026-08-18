/** One statement of a batch. `run` reports `changes`; `read` returns `rows`. */
export interface StoreBatchStatement {
  sql: string
  params: unknown[]
  kind: 'run' | 'read'
}

export interface StoreBatchResult {
  changes: number
  rows: unknown[]
}

export interface StoreQueryResult {
  rows: unknown[]
  changes: number
}

/** The statement surface a transaction callback gets — the same shape as the database itself,
 *  minus the lifecycle members a callback must not touch while its transaction is open. */
export interface StoreTx {
  exec(sql: string): Promise<void>
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  /** Run an ordered statement list and return its results in the same order. */
  batch(statements: StoreBatchStatement[]): Promise<StoreBatchResult[]>
}

/** The async store seam: every method resolves only once its writes are durable. */
export interface StoreDatabase extends StoreTx {
  /** Run `fn` inside one transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  close(): Promise<void>
}
