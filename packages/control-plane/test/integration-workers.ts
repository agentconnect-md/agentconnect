const DEFAULT_INTEGRATION_TEST_WORKERS = 4

/**
 * Keep the Vitest worker count and the number of cloned Postgres databases in
 * lockstep. CI can tune this for a smaller runner without changing the harness.
 */
export function integrationTestWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INTEGRATION_TEST_WORKERS
  if (raw === undefined) return DEFAULT_INTEGRATION_TEST_WORKERS

  const workers = Number(raw)
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`INTEGRATION_TEST_WORKERS must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return workers
}
