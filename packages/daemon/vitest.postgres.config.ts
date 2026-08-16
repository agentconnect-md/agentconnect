import { defineConfig } from 'vitest/config'
import { storePostgresWorkerCount } from './test/store-postgres/workers.js'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

/**
 * The `store-postgres` project: the daemon's store suites re-run with `LocalStore` opened
 * over `PostgresSyncDatabase` instead of `node:sqlite`, against a Testcontainers
 * `postgres:16-alpine`. The pool runs this SQL for real, so SQLite-only constructs
 * (two-arg `MAX`/`MIN`, `IFNULL`, `datetime()`, …) fail here instead of on a cluster.
 *
 * A separate config file, not a second project in `vitest.config.ts`, so `vitest run` and
 * every targeted `vitest run <file>` in CI stay Docker-free.
 */
export default defineConfig({
  test: {
    name: 'store-postgres',
    environment: 'node',
    include: [
      'test/local-store.test.ts',
      'test/memory-capture-outbox.test.ts',
      'test/postgres-pool-store.int.test.ts',
      'test/postgres-transcript-org.int.test.ts'
    ],
    globalSetup: ['./test/store-postgres/global-setup.ts'],
    setupFiles: ['./test/store-postgres/setup.ts'],
    maxWorkers: storePostgresWorkerCount(),
    fileParallelism: true,
    hookTimeout: 120_000,
    // Every statement is a round trip to a Dockerized Postgres through a worker thread,
    // so Vitest's 5s unit budget would time out on runner weather, not on the code.
    testTimeout: 30_000,
    reporters: githubActionsReporters('daemon-store-postgres.md')
  }
})
