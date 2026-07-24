import { defineConfig } from 'vitest/config'
import { integrationTestWorkerCount } from './test/integration-workers.js'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

const integrationWorkers = integrationTestWorkerCount()

// Vitest config for @agentconnect.md/control-plane (design section 5.1).
//
// Two projects:
//  - "unit"        : co-located src/**/*.test.ts; pure logic (codec, fencing
//                    predicates, placement policy). Fast, no I/O, NO Docker.
//                    This is the inner red-green loop (`pnpm test:unit`).
//  - "integration" : test/**/*.test.ts; real infra (Prisma repos, Fastify
//                    inject, real ws handshake). Postgres-gated via Testcontainers.
//
// The integration project boots one `postgres:16-alpine`, migrates + seeds its
// base database, then clones one database per Vitest pool. Pool-local TRUNCATEs
// preserve per-test isolation while files run concurrently. The worker count is
// configurable through INTEGRATION_TEST_WORKERS (default 4).
export default defineConfig({
  test: {
    pool: 'threads',
    reporters: githubActionsReporters('control-plane.md'),
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.unit.test.ts', 'test/protocol/fencing.test.ts'],
          environment: 'node'
        }
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.unit.test.ts', 'test/protocol/fencing.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.db.ts'],
          maxWorkers: integrationWorkers,
          fileParallelism: true,
          hookTimeout: 120_000
        }
      }
    ]
  }
})
