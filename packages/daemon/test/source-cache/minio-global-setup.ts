// Global setup for the source-cache-minio project: one MinIO server, built from pinned source, per run.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProvidedContext } from 'vitest'

// MinIO publishes no images since it went source-only, so CI builds this commit (RELEASE.2025-10-15T17-29-55Z).
export const MINIO_COMMIT = '9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a'
const BIN_ENV = 'AC_TEST_MINIO_BIN'
const ACCESS_KEY = 'acsourcecache'
const SECRET_KEY = 'acsourcecache-secret'
const READY_TIMEOUT_MS = 60_000

let server: ChildProcess | undefined
let dataDir: string | undefined

/** Vitest passes a `TestProject` but exports no `GlobalSetupContext`, so type what we use. */
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitLive(endpoint: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MinIO exited with ${child.exitCode} before it was live:\n${output()}`)
    try {
      const res = await fetch(`${endpoint}/minio/health/live`)
      if (res.status === 200) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`MinIO was not live within ${READY_TIMEOUT_MS} ms:\n${output()}`)
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const bin = process.env[BIN_ENV]
  if (!bin) {
    const howTo = `build it with \`go install github.com/minio/minio@${MINIO_COMMIT}\` and set ${BIN_ENV} to the binary`
    if (process.env.CI) throw new Error(`${BIN_ENV} is unset: ${howTo}`)
    console.warn(`Skipping the Source Cache MinIO suite: ${BIN_ENV} is unset; ${howTo}.`)
    return
  }
  dataDir = mkdtempSync(join(tmpdir(), 'ac-minio-'))
  const [port, consolePort] = [await freePort(), await freePort()]
  const address = `127.0.0.1:${port}`
  let log = ''
  server = spawn(bin, ['server', dataDir, '--address', address, '--console-address', `127.0.0.1:${consolePort}`], {
    env: { ...process.env, MINIO_ROOT_USER: ACCESS_KEY, MINIO_ROOT_PASSWORD: SECRET_KEY },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const append = (chunk: Buffer): void => {
    log = (log + chunk.toString('utf8')).slice(-8192)
  }
  server.stdout?.on('data', append)
  server.stderr?.on('data', append)
  const spawned = new Promise<void>((resolve, reject) => {
    server?.once('spawn', resolve)
    server?.once('error', reject)
  })
  const endpoint = `http://${address}`
  try {
    await spawned
    await waitLive(endpoint, server, () => log)
  } catch (error) {
    await teardown()
    throw error
  }
  provide('sourceCacheMinio', { endpoint, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1' })
}

export async function teardown(): Promise<void> {
  const child = server
  server = undefined
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    const forced = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await exited
    clearTimeout(forced)
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
  dataDir = undefined
}

declare module 'vitest' {
  export interface ProvidedContext {
    sourceCacheMinio?: { endpoint: string; accessKeyId: string; secretAccessKey: string; region: string }
  }
}
