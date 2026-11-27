import { randomUUID } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Backoff, systemClock, type Clock } from '@agentconnect.md/connection'
import { runtimeStoreDir } from '../paths.js'

// Shared by both runtime stores: the staging trees installs fill before their rename, and one install per key.

const STAGING_PREFIX = '.staging-'
// A failed install waits this long before its next attempt, doubling per consecutive failure up to the cap.
export const INSTALL_RETRY_BASE_MS = 30_000
export const INSTALL_RETRY_CAP_MS = 10 * 60_000

/** A fresh staging directory in the store; an install renames it into place only once it is complete. */
export function runtimeStagingDir(root: string): string {
  return join(runtimeStoreDir(root), `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`)
}

/** Remove the staging trees a process that died mid-install left behind; call only before this process starts one. */
export function sweepRuntimeStaging(root: string, log?: { warn(message: string): void }): void {
  const store = runtimeStoreDir(root)
  let names: string[]
  try {
    names = readdirSync(store)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    try {
      rmSync(join(store, name), { recursive: true, force: true })
    } catch (err) {
      log?.warn(`runtimes: could not remove the abandoned install ${name} — ${(err as Error).message}`)
    }
  }
}

/** One install per key: concurrent callers share an attempt, a success is kept, a failure retries after a backoff. */
export class InstallMemo<T> {
  private readonly runs = new Map<string, Promise<T>>()
  private readonly failures = new Map<string, { error: unknown; retryAt: number; backoff: Backoff }>()

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly log?: { info(message: string): void }
  ) {}

  run(key: string, install: () => Promise<T>): Promise<T> {
    const existing = this.runs.get(key)
    if (existing) return existing
    const failed = this.failures.get(key)
    // Inside the backoff every caller gets the last failure, so a persistent fault costs no npm run or fetch per call.
    if (failed && this.clock.now() < failed.retryAt) return Promise.reject(failed.error)
    const run = install()
    this.runs.set(key, run)
    run.then(
      () => this.failures.delete(key),
      (error: unknown) => {
        this.runs.delete(key)
        const backoff =
          failed?.backoff ??
          new Backoff({ baseMs: INSTALL_RETRY_BASE_MS, capMs: INSTALL_RETRY_CAP_MS, jitter: () => 0 })
        const delay = backoff.next()
        this.failures.set(key, { error, retryAt: this.clock.now() + delay, backoff })
        this.log?.info(`runtimes: installing ${key} failed; the next attempt waits ${Math.round(delay / 1000)}s`)
      }
    )
    return run
  }
}
