import { defineConfig } from 'vitest/config'
import { integrationTestWorkerCount } from './test/integration-workers.js'
import { CostBalancedSequencer } from './test/shard-sequencer.js'
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
    // `--shard` otherwise splits by file COUNT, which is blind to cost and leaves the shard holding
    // the expensive files to absorb every bad-runner minute. Weight and pack them instead — see
    // `test/shard-sequencer.ts`. Vitest resolves ONE sequencer per run and only calls `shard()` when
    // `--shard` is passed, so the unit project (never sharded) keeps the stock behavior.
    sequence: { sequencer: CostBalancedSequencer },
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
          hookTimeout: 120_000,
          // Vitest's 5s default is a unit-test budget, and it is the FIRST wall a
          // test here hits: its clock starts before any repo call opens its own
          // transaction, so a stalled statement always surfaces as an opaque
          // "Test timed out in 5000ms" rather than the Postgres/Prisma error that
          // explains it. These tests share one Dockerized Postgres across
          // `integrationWorkers` workers, so a multi-second stall (a CI runner
          // whose vCPUs are oversubscribed, a Docker Desktop I/O hiccup) is
          // ordinary weather, not a hang. 30s stays above the 20s transaction
          // budget `setup.db.ts` sets, so a genuine lock cycle fails with the real
          // Prisma error instead of being cut short by this one.
          testTimeout: 30_000
        }
      }
    ]
  }
})
