// Global setup for the source-cache-minio project: one MinIO (the version the P0 store matrix measured) per run.
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import type { ProvidedContext } from 'vitest'

export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z'
const ACCESS_KEY = 'acsourcecache'
const SECRET_KEY = 'acsourcecache-secret'

let container: StartedTestContainer | undefined

/** Vitest passes a `TestProject` but exports no `GlobalSetupContext`, so type what we use. */
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start()
  provide('sourceCacheMinio', {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: 'us-east-1'
  })
}

export async function teardown(): Promise<void> {
  await container?.stop()
}

declare module 'vitest' {
  export interface ProvidedContext {
    sourceCacheMinio?: { endpoint: string; accessKeyId: string; secretAccessKey: string; region: string }
  }
}
