/**
 * Vitest global setup for the `integration` project (design §5.2).
 *
 * Boots ONE `postgres:16-alpine` via Testcontainers, applies the committed
 * migrations with `prisma migrate deploy` (so the real partial-unique index, the
 * `threadKey` generated column, and `BigInt` columns are exercised against real
 * Postgres — not pglite, not a mock), seeds the default Org/User, then hands the
 * connection URI to the test process via `provide("databaseUrl", …)` and
 * `process.env.DATABASE_URL`.
 *
 * `teardown` stops the container. One container per Vitest process; per-test
 * isolation is `TRUNCATE … RESTART IDENTITY CASCADE` in `setup.db.ts`.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { execa } from 'execa'
import type { ProvidedContext } from 'vitest'
import { integrationTestWorkerCount } from './integration-workers.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const schemaPath = resolve(packageRoot, 'prisma/schema.prisma')
const seedEntry = resolve(packageRoot, 'prisma/seed.ts')

let container: StartedPostgreSqlContainer | undefined

/**
 * Minimal structural type for the global-setup context. Vitest 4 passes a
 * `TestProject` (which exposes `provide`) but no longer exports a named
 * `GlobalSetupContext`, so we type only what we use.
 */
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

function workerDatabaseName(poolId: number): string {
  return `test_worker_${poolId}`
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function cloneWorkerDatabases(baseUrl: string, workers: number): Promise<string[]> {
  if (!container) throw new Error('Postgres container is not running')

  const urls: string[] = []
  for (let poolId = 1; poolId <= workers; poolId += 1) {
    const database = workerDatabaseName(poolId)
    const result = await container.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE "${database}" WITH TEMPLATE "${container.getDatabase()}" OWNER "${container.getUsername()}"`
    ])
    if (result.exitCode !== 0) {
      throw new Error(`failed to create ${database}: ${result.output}`)
    }
    urls.push(databaseUrl(baseUrl, database))
  }
  return urls
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()

  // Apply committed migrations (the hand-edited SQL included) to real Postgres.
  await execa('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit'
  })

  // Seed default Org + owner User so FK-bearing fixtures have a tenancy anchor.
  await execa('pnpm', ['exec', 'tsx', seedEntry], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit'
  })

  // Each Vitest pool gets a private clone of the migrated + seeded database.
  // Files can now run concurrently without one worker truncating another's data.
  const databaseUrls = await cloneWorkerDatabases(url, integrationTestWorkerCount())
  provide('databaseUrls', databaseUrls)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: string[]
  }
}
