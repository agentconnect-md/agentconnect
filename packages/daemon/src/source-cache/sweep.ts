import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type { LocalStore, SourceCacheDeleteResult, SourceCacheObjectRow } from '../store/local-store.js'
import type { SourceCacheLimits } from './config.js'
import { SOURCE_CACHE_GRACE_SECONDS } from './config.js'
import { parseSourceCacheObjectKey, type SourceCacheObjectKey } from './keys.js'
import { evaluateSourceCacheLifecycle, sourceCacheLifecycleRules, sourceCacheSrcPrefix } from './lifecycle.js'
import { SourceCacheObjectError, type SourceCacheObjectClient } from './object-client.js'

// The Source Cache sweep (source-cache.md §9 abandoned uploads, §10): every pool member, idempotent, over leased claims.

export const SWEEP_INTERVAL_MS = 5 * 60_000
export const SWEEP_BATCH_SIZE = 25
export const SWEEP_LEASE_MS = 15 * 60_000
export const SWEEP_MAX_OBJECT_FAILURES = 3
export const LIFECYCLE_CHECK_MS = 6 * 60 * 60_000
const DAY_MS = 86_400_000

/** `present` both rules exist; `missing` the bucket affirmatively lacks one; `unknown` it could not be read. */
export type SourceCacheLifecycleStatus = 'present' | 'missing' | 'unknown'

export interface SourceCacheSweepCounts {
  claimed: number
  deleted: number
  objectDeleted: number
  alreadyGone: number
  retagged: number
  failed: number
  /** The row was gone or another member's claim had replaced ours. */
  lost: number
  changed: number
  referenced: number
  releasedBytes: number
}

export type SourceCacheSweepPass =
  | { kind: 'busy' }
  | {
      kind: 'done'
      pending: SourceCacheSweepCounts
      unreferenced: SourceCacheSweepCounts
      pointers: SourceCacheSweepCounts
    }

export type SourceCacheSweepStore = Pick<
  LocalStore,
  | 'claimExpiredPendingSourceCache'
  | 'claimUnreferencedSourceCacheBundles'
  | 'claimUnreadSourceCachePointers'
  | 'deleteSourceCacheObject'
>

export interface SourceCacheSweeperDeps {
  store: () => SourceCacheSweepStore | undefined
  objects: Pick<SourceCacheObjectClient, 'head' | 'delete' | 'putTagging' | 'getBucketLifecycle'>
  config: { prefix: string; limits: Pick<SourceCacheLimits, 'getUrlSeconds' | 'unreadPointerDays'> }
  clock: Clock
  random?: () => number
  batchSize?: number
  leaseMs?: number
  intervalMs?: number
  lifecycleCheckMs?: number
  maxObjectFailures?: number
  /** True while the daemon drains: a tick that lands then is skipped. */
  paused?: () => boolean
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void }
  /** Metrics hook for each completed pass. */
  onPass?: (pass: Extract<SourceCacheSweepPass, { kind: 'done' }>) => void
  /** Metrics hook for each lifecycle check's status. */
  onLifecycle?: (status: SourceCacheLifecycleStatus) => void
}

export interface SourceCacheSweeper {
  /** One pass as `owner`; `busy` while another pass of this member runs. Never throws. */
  runPass(owner: string): Promise<SourceCacheSweepPass>
  /** Read the bucket's lifecycle configuration and update `lifecycle()`. Never throws. */
  checkLifecycle(): Promise<SourceCacheLifecycleStatus>
  lifecycle(): SourceCacheLifecycleStatus
  start(owner: string): void
  /** Clear the timers, stop the pass between rows, and wait for it. */
  stop(): Promise<void>
}

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)
}

const emptyCounts = (): SourceCacheSweepCounts => ({
  claimed: 0,
  deleted: 0,
  objectDeleted: 0,
  alreadyGone: 0,
  retagged: 0,
  failed: 0,
  lost: 0,
  changed: 0,
  referenced: 0,
  releasedBytes: 0
})

/** A 404 for the key, not for the bucket, means the object is already gone. */
const objectGone = (err: unknown): boolean =>
  err instanceof SourceCacheObjectError && err.status === 404 && err.code !== 'NoSuchBucket'

function unrefTimer(handle: TimerHandle): void {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) (handle as { unref(): void }).unref()
}

export function createSourceCacheSweeper(deps: SourceCacheSweeperDeps): SourceCacheSweeper {
  const { clock, objects, log } = deps
  const random = deps.random ?? Math.random
  const batchSize = deps.batchSize ?? SWEEP_BATCH_SIZE
  const leaseMs = deps.leaseMs ?? SWEEP_LEASE_MS
  const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS
  const lifecycleCheckMs = deps.lifecycleCheckMs ?? LIFECYCLE_CHECK_MS
  const maxObjectFailures = deps.maxObjectFailures ?? SWEEP_MAX_OBJECT_FAILURES
  let running: Promise<SourceCacheSweepPass> | undefined
  let lifecycleRunning: Promise<SourceCacheLifecycleStatus> | undefined
  let status: SourceCacheLifecycleStatus = 'unknown'
  let stopped = false
  let started = false
  let passTimer: TimerHandle | undefined
  let lifecycleTimer: TimerHandle | undefined

  const pass = async (owner: string): Promise<Extract<SourceCacheSweepPass, { kind: 'done' }>> => {
    const result = {
      kind: 'done' as const,
      pending: emptyCounts(),
      unreferenced: emptyCounts(),
      pointers: emptyCounts()
    }
    const store = deps.store()
    if (!store) return result
    // Past half the lease another member may re-claim our rows, so no new row starts after it.
    const deadline = clock.now() + leaseMs / 2
    let objectFailures = 0
    const inTime = (): boolean => !stopped && clock.now() < deadline
    const objectsHealthy = (): boolean => objectFailures < maxObjectFailures
    const objectStep = async <T>(
      step: () => Promise<T>
    ): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> => {
      try {
        const value = await step()
        objectFailures = 0
        return { ok: true, value }
      } catch (err) {
        if (!objectGone(err)) objectFailures++
        return { ok: false, err }
      }
    }
    const claim = async (
      counts: SourceCacheSweepCounts,
      what: string,
      run: () => Promise<SourceCacheObjectRow[]>
    ): Promise<SourceCacheObjectRow[]> => {
      try {
        const rows = await run()
        counts.claimed += rows.length
        return rows
      } catch (err) {
        counts.failed++
        log.warn(`source cache sweep: claiming ${what} failed (${detailOf(err)})`)
        return []
      }
    }
    const remove = async (
      counts: SourceCacheSweepCounts,
      row: SourceCacheObjectRow,
      guarded: boolean
    ): Promise<SourceCacheDeleteResult | undefined> => {
      try {
        const deleted = await store.deleteSourceCacheObject({
          orgId: row.orgId,
          key: row.key,
          now: clock.now(),
          claimedBy: owner,
          ...(guarded
            ? { unchanged: { targetKey: row.targetKey, updatedAt: row.updatedAt, lastReadAt: row.lastReadAt } }
            : {})
        })
        if (deleted.deleted) {
          counts.deleted++
          counts.releasedBytes += deleted.releasedBytes
        } else if (deleted.reason === 'changed') counts.changed++
        else if (deleted.reason === 'referenced') counts.referenced++
        else counts.lost++
        return deleted
      } catch (err) {
        counts.failed++
        log.warn(`source cache sweep: deleting the row of ${row.key} failed (${detailOf(err)})`)
        return undefined
      }
    }
    const bundleKeyOf = (
      counts: SourceCacheSweepCounts,
      row: SourceCacheObjectRow
    ): SourceCacheObjectKey | undefined => {
      if (parseSourceCacheObjectKey(row.key)?.kind === 'bundle') return row.key as SourceCacheObjectKey
      counts.failed++
      log.warn(`source cache sweep: claimed row ${row.key} is not a bundle key`)
      return undefined
    }

    // (a) Expired reservations: delete any object the abandoned upload left, then the row, which releases the reservation.
    if (inTime() && objectsHealthy()) {
      const counts = result.pending
      const rows = await claim(counts, 'expired reservations', () =>
        store.claimExpiredPendingSourceCache({ owner, now: clock.now(), leaseMs, limit: batchSize })
      )
      for (const row of rows) {
        if (!inTime() || !objectsHealthy()) break
        const key = bundleKeyOf(counts, row)
        if (!key) continue
        const head = await objectStep(() => objects.head(key))
        if (!head.ok) {
          counts.failed++
          log.warn(`source cache sweep: HEAD ${row.key} failed (${detailOf(head.err)})`)
          continue
        }
        if (head.value.exists) {
          const deleted = await objectStep(() => objects.delete(key))
          if (!deleted.ok) {
            counts.failed++
            log.warn(`source cache sweep: DELETE ${row.key} failed (${detailOf(deleted.err)})`)
            continue
          }
          counts.objectDeleted++
        } else counts.alreadyGone++
        await remove(counts, row, false)
      }
    }

    // (b) Bundles unpointed past every GET URL issued for them: retag for the lifecycle rule, then release the row's bytes.
    if (inTime() && objectsHealthy()) {
      const counts = result.unreferenced
      const unpointedBefore = clock.now() - (deps.config.limits.getUrlSeconds + SOURCE_CACHE_GRACE_SECONDS) * 1000
      const rows = await claim(counts, 'unreferenced bundles', () =>
        store.claimUnreferencedSourceCacheBundles({
          owner,
          now: clock.now(),
          leaseMs,
          limit: batchSize,
          unpointedBefore
        })
      )
      for (const row of rows) {
        if (!inTime() || !objectsHealthy()) break
        const key = bundleKeyOf(counts, row)
        if (!key) continue
        const retag = await objectStep(() => objects.putTagging(key, 'ac-cache=unreferenced'))
        if (retag.ok) counts.retagged++
        else if (objectGone(retag.err)) counts.alreadyGone++
        else {
          // The row keeps its bytes until the object carries the tag the lifecycle collects; the claim makes it terminal.
          counts.failed++
          log.warn(`source cache sweep: retagging ${row.key} unreferenced failed (${detailOf(retag.err)})`)
          continue
        }
        const deleted = await remove(counts, row, false)
        if (deleted && !deleted.deleted && deleted.reason === 'referenced') {
          log.warn(`source cache sweep: ${row.key} is referenced again; restoring its live tag`)
          await objects.putTagging(key, 'ac-cache=live').catch((err: unknown) => {
            log.warn(`source cache sweep: restoring ${row.key} to live failed (${detailOf(err)})`)
          })
        }
      }
    }

    // (c) Unread pointers: delete the row only if no read or write touched it since the claim; its bundle then ages out via (b).
    if (inTime()) {
      const counts = result.pointers
      const unreadBefore = clock.now() - deps.config.limits.unreadPointerDays * DAY_MS
      const rows = await claim(counts, 'unread pointers', () =>
        store.claimUnreadSourceCachePointers({ owner, now: clock.now(), leaseMs, limit: batchSize, unreadBefore })
      )
      for (const row of rows) {
        if (!inTime()) break
        await remove(counts, row, true)
      }
    }
    return result
  }

  const report = (done: Extract<SourceCacheSweepPass, { kind: 'done' }>): void => {
    const parts = (['pending', 'unreferenced', 'pointers'] as const)
      .filter((step) => done[step].claimed > 0 || done[step].failed > 0)
      .map((step) => {
        const c = done[step]
        return `${step}: claimed=${c.claimed} deleted=${c.deleted} objectDeleted=${c.objectDeleted} alreadyGone=${c.alreadyGone} retagged=${c.retagged} failed=${c.failed} lost=${c.lost} changed=${c.changed} referenced=${c.referenced} released=${c.releasedBytes}`
      })
    if (parts.length) log.info(`source cache sweep: ${parts.join('; ')}`)
    else log.debug('source cache sweep: nothing due')
    try {
      deps.onPass?.(done)
    } catch {
      // A metrics hook never fails a pass.
    }
  }

  const runPass = async (owner: string): Promise<SourceCacheSweepPass> => {
    if (running) return { kind: 'busy' }
    const current = pass(owner)
      .then((done) => {
        report(done)
        return done
      })
      .catch((err: unknown): SourceCacheSweepPass => {
        log.warn(`source cache sweep: pass failed (${detailOf(err)})`)
        return { kind: 'done', pending: emptyCounts(), unreferenced: emptyCounts(), pointers: emptyCounts() }
      })
    running = current
    try {
      return await current
    } finally {
      running = undefined
    }
  }

  const checkLifecycle = async (): Promise<SourceCacheLifecycleStatus> => {
    if (lifecycleRunning) return await lifecycleRunning
    const current = (async (): Promise<SourceCacheLifecycleStatus> => {
      const src = sourceCacheSrcPrefix(deps.config.prefix)
      let next: SourceCacheLifecycleStatus
      try {
        const lifecycle = await objects.getBucketLifecycle()
        const evaluation =
          lifecycle.kind === 'none'
            ? { pending: false, unreferenced: false, warnings: [] }
            : evaluateSourceCacheLifecycle(lifecycle.xml, deps.config.prefix)
        for (const warning of evaluation.warnings) log.warn(`source cache: ${warning}`)
        next = evaluation.pending && evaluation.unreferenced ? 'present' : 'missing'
        if (next === 'missing') {
          const lacking = [
            evaluation.pending ? '' : 'ac-cache=pending',
            evaluation.unreferenced ? '' : 'ac-cache=unreferenced'
          ]
            .filter(Boolean)
            .join(' and ')
          log.warn(
            `source cache: the bucket has no enabled lifecycle rule expiring ${lacking} under ${src}; write-back is disabled until it does. Merge these rules into the bucket's lifecycle configuration: ${JSON.stringify(sourceCacheLifecycleRules(deps.config.prefix))}`
          )
        } else if (status !== 'present') log.info(`source cache: bucket lifecycle rules for ${src} are present`)
      } catch (err) {
        next = 'unknown'
        log.warn(
          `source cache: could not read the bucket lifecycle configuration (${detailOf(err)}); the member needs s3:GetLifecycleConfiguration to verify the ${src} rules`
        )
      }
      status = next
      try {
        deps.onLifecycle?.(next)
      } catch {
        // A metrics hook never fails a check.
      }
      return next
    })()
    lifecycleRunning = current
    try {
      return await current
    } finally {
      lifecycleRunning = undefined
    }
  }

  const armPass = (owner: string, delayMs: number): void => {
    if (stopped) return
    passTimer = clock.setTimeout(() => {
      passTimer = undefined
      if (stopped) return
      const next = (): void => armPass(owner, intervalMs * (0.75 + 0.5 * random()))
      if (deps.paused?.()) return next()
      void runPass(owner).finally(next)
    }, delayMs)
    unrefTimer(passTimer)
  }

  const armLifecycle = (): void => {
    if (stopped) return
    lifecycleTimer = clock.setTimeout(() => {
      lifecycleTimer = undefined
      if (stopped) return
      void checkLifecycle().finally(armLifecycle)
    }, lifecycleCheckMs)
    unrefTimer(lifecycleTimer)
  }

  return {
    runPass,
    checkLifecycle,
    lifecycle: () => status,
    start(owner) {
      if (stopped || started) return
      started = true
      void checkLifecycle()
      armLifecycle()
      armPass(owner, intervalMs * random())
    },
    async stop() {
      stopped = true
      if (passTimer !== undefined) clock.clearTimeout(passTimer)
      if (lifecycleTimer !== undefined) clock.clearTimeout(lifecycleTimer)
      passTimer = undefined
      lifecycleTimer = undefined
      await Promise.allSettled([running, lifecycleRunning])
    }
  }
}
