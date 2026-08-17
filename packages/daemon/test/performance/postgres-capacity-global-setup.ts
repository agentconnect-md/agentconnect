import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import type { ProvidedContext } from 'vitest'

export const POSTGRES_CAPACITY_IMAGE = 'postgres:16-alpine'

let container: StartedPostgreSqlContainer | undefined

interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer(POSTGRES_CAPACITY_IMAGE).start()
  const databaseUrl = container.getConnectionUri()
  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    const result = await client.query<{ server_version: string }>('SHOW server_version')
    const postgresVersion = result.rows[0]?.server_version
    if (!postgresVersion) throw new Error('PostgreSQL did not return server_version')
    provide('postgresCapacityDatabaseUrl', databaseUrl)
    provide('postgresCapacityImage', POSTGRES_CAPACITY_IMAGE)
    provide('postgresCapacityVersion', postgresVersion)
  } catch (error) {
    await container.stop()
    container = undefined
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function teardown(): Promise<void> {
  await container?.stop()
  container = undefined
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgresCapacityDatabaseUrl: string
    postgresCapacityImage: string
    postgresCapacityVersion: string
  }
}
