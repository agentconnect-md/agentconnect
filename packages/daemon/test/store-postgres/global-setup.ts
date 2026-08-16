/**
 * Vitest global setup for the `store-postgres` project.
 *
 * Boots ONE `postgres:16-alpine` via Testcontainers and hands each Vitest pool its own
 * database, so the store suites run the real `LocalStore` SQL through the real
 * `PostgresSyncDatabase` worker instead of SQLite. Per-test isolation is a schema-wide
 * sweep in `setup.ts`; per-worker isolation is the separate database created here.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { ProvidedContext } from 'vitest'
import { storePostgresWorkerCount } from './workers.js'

let container: StartedPostgreSqlContainer | undefined

/** Vitest 4 passes a `TestProject` but exports no `GlobalSetupContext`, so type what we use. */
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const base = container.getConnectionUri()
  const urls: string[] = []
  for (let poolId = 1; poolId <= storePostgresWorkerCount(); poolId += 1) {
    const database = `store_worker_${poolId}`
    const result = await container.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE "${database}" OWNER "${container.getUsername()}"`
    ])
    if (result.exitCode !== 0) throw new Error(`failed to create ${database}: ${result.output}`)
    urls.push(databaseUrl(base, database))
  }
  provide('storeDatabaseUrls', urls)
}

export async function teardown(): Promise<void> {
  await container?.stop()
}

declare module 'vitest' {
  export interface ProvidedContext {
    storeDatabaseUrls: string[]
  }
}
