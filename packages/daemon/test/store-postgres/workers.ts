const DEFAULT_STORE_POSTGRES_WORKERS = 2

/** Keep the Vitest worker count and the number of per-worker databases in lockstep. */
export function storePostgresWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STORE_POSTGRES_TEST_WORKERS
  if (raw === undefined) return DEFAULT_STORE_POSTGRES_WORKERS
  const workers = Number(raw)
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`STORE_POSTGRES_TEST_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return workers
}
