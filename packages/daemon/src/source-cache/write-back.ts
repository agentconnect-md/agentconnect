import type { LocalStore, SourceCacheReserveResult } from '../store/local-store.js'
import type { BundleFallbackReason } from '../workspace/bundled-clone.js'
import { WRITE_BACK_FALLBACK_REASONS } from './bundle-retry.js'
import type { GitRunner } from '../workspace/git-runner.js'
import type { SourceCacheLimits } from './config.js'
import { bundleKey, newBundleId, refHash, type SourceCacheClass, type SourceCacheShape } from './keys.js'
import type { SourceCacheObjectClient } from './index.js'
import type { SourceCachePresigner } from './presigner.js'
import type { SourceCacheWriteTarget } from './read-plan.js'

// Workspace and skill write-back (source-cache.md §7 item 4, §8, §9): asynchronous, best-effort, never an exception into a session.

/** A delta above either threshold after a hit makes the clone a write-back candidate (§7). */
export const WRITE_BACK_DELTA_OBJECTS = 5_000
export const WRITE_BACK_DELTA_BYTES = 50 * 1024 * 1024
/** A hit on a bundle older than this is a candidate too. */
export const WRITE_BACK_MAX_BUNDLE_AGE_MS = 7 * 24 * 60 * 60_000
const DEFAULT_MAX_CONCURRENT = 2
export { WRITE_BACK_FALLBACK_REASONS }

/** The shim's `bundle` operations as the writer needs them; the handle is minted in the pod, never a path. */
export interface SourceCacheBundleStager {
  create(
    input: { cwd: string; ref: string; commit: string; shape: SourceCacheShape; maxBytes: number },
    abort?: AbortSignal
  ): Promise<{ handle: string; bytes: number; sha256: string }>
  upload(
    input: { handle: string; url: string; headers: Record<string, string> },
    abort?: AbortSignal
  ): Promise<{ bytes: number; sha256: string }>
  discard(handle: string, abort?: AbortSignal): Promise<void>
}

export interface SourceCacheWriteRequest {
  target: SourceCacheWriteTarget
  /** How the clone read the cache: `uncached` is a miss; a hit carries the bundle tip and its row's age, a fallback its reason. */
  read: { kind: 'uncached' | 'hit' | 'fallback'; tip?: string; bundleCreatedAt?: number; reason?: BundleFallbackReason }
  /** The checkout in the pod's coordinates. */
  checkout: string
  /** A runner rooted at the checkout under the local, no-lazy-fetch env. */
  git: GitRunner
  stager: SourceCacheBundleStager | undefined
  /** Whether the clone instruction the daemon issued carried the managed credential. */
  credentialed: boolean
  abort?: AbortSignal
}

/** A bundle the shim already created (a skill clone's): the writer skips measuring and `create`, and still discards it. */
export interface SourceCacheStagedWriteRequest {
  target: SourceCacheWriteTarget
  staged: { handle: string; bytes: number; sha256: string; branch: string }
  trigger: Exclude<SourceCacheWriteTrigger, 'delta'>
  stager: Pick<SourceCacheBundleStager, 'upload' | 'discard'>
  /** Whether the clone the daemon planned carried the managed credential. */
  credentialed: boolean
  abort?: AbortSignal
}

/** The `scope` metric label: whose clone the bundle came from. */
export type SourceCacheWriteScope = 'workspace' | 'skill'

export type SourceCacheWriteTrigger = 'miss' | 'fallback' | 'stale' | 'delta'
export type SourceCacheWriteStage =
  'measure' | 'create' | 'reserve' | 'presign' | 'upload' | 'verify' | 'commit' | 'retag' | 'pointer'

/** Why a write-back did not run: a closed set, so it can label a metric; free text goes in `detail`. */
export type SourceCacheWriteSkipReason =
  | 'lifecycle-missing'
  | 'class-mismatch'
  | 'unsupported-shim'
  | 'branch-diverged'
  | 'unresolved'
  | `fallback-${BundleFallbackReason | 'unknown'}`
  | 'no-tip'
  | 'unmeasured'
  | 'fresh'
  | 'in-flight'
  | 'busy'
  | 'store-unavailable'
  | 'pointer-moved'
  | 'over-cap'
  | `reservation-${Extract<SourceCacheReserveResult, { admitted: false }>['reason']}`

export type SourceCacheWriteOutcome =
  | { kind: 'skipped'; reason: SourceCacheWriteSkipReason; detail?: string }
  | { kind: 'written'; trigger: SourceCacheWriteTrigger; bundleKey: string; bytes: number }
  | { kind: 'lost-race'; bundleKey: string }
  | { kind: 'failed'; stage: SourceCacheWriteStage; detail: string; bundleKey?: string }

export interface SourceCacheWriter {
  /** Decide and run one workspace write-back; always resolves. */
  consider(request: SourceCacheWriteRequest): Promise<SourceCacheWriteOutcome>
  /** Run one write-back of a shim-staged skill bundle; always resolves and always discards its handle. */
  considerStaged(request: SourceCacheStagedWriteRequest): Promise<SourceCacheWriteOutcome>
}

export interface SourceCacheWriterDeps {
  store: () =>
    Pick<LocalStore, 'reserveBundle' | 'commitBundle' | 'setSourceCachePointer' | 'getSourceCacheObject'> | undefined
  presigner: Pick<SourceCachePresigner, 'presignPut'>
  objects: Pick<SourceCacheObjectClient, 'head' | 'putTagging'>
  limits: Pick<SourceCacheLimits, 'maxBundleBytes' | 'orgQuotaBytes' | 'pendingReservationSeconds'>
  thresholds?: { deltaObjects?: number; deltaBytes?: number; maxBundleAgeMs?: number }
  maxConcurrent?: number
  now?: () => number
  log: { debug(message: string): void; info(message: string): void; warn(message: string): void }
  /** False while the bucket affirmatively lacks the lifecycle rules (§14 fallback); omitted means always allowed. */
  allowWrites?: () => boolean
  /** Metrics hook; `scope` is the target's shape, class and whose clone it was, never its org or key. */
  onOutcome?: (
    outcome: SourceCacheWriteOutcome,
    scope: { shape: SourceCacheShape; repoClass: SourceCacheClass; scope: SourceCacheWriteScope }
  ) => void
}

class Stop extends Error {
  constructor(readonly outcome: SourceCacheWriteOutcome) {
    super(outcome.kind)
  }
}

const skip = (reason: SourceCacheWriteSkipReason, detail?: string): never => {
  throw new Stop({ kind: 'skipped', reason, ...(detail !== undefined ? { detail } : {}) })
}

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)
}

export function createSourceCacheWriter(deps: SourceCacheWriterDeps): SourceCacheWriter {
  const now = deps.now ?? Date.now
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const deltaObjects = deps.thresholds?.deltaObjects ?? WRITE_BACK_DELTA_OBJECTS
  const deltaBytes = deps.thresholds?.deltaBytes ?? WRITE_BACK_DELTA_BYTES
  const maxAgeMs = deps.thresholds?.maxBundleAgeMs ?? WRITE_BACK_MAX_BUNDLE_AGE_MS
  const inFlight = new Set<string>()

  const record = (
    target: SourceCacheWriteTarget,
    outcome: SourceCacheWriteOutcome,
    scope: SourceCacheWriteScope
  ): SourceCacheWriteOutcome => {
    const where = target.pointerKey
    if (outcome.kind === 'written') {
      deps.log.info(
        `source cache: wrote ${outcome.bundleKey} (${outcome.bytes} bytes, ${outcome.trigger}) for ${where}`
      )
    } else if (outcome.kind === 'failed') {
      deps.log.warn(`source cache: write-back failed at ${outcome.stage} for ${where} (${outcome.detail})`)
    } else if (outcome.kind === 'lost-race') {
      deps.log.debug(`source cache: ${outcome.bundleKey} lost the pointer race for ${where}`)
    } else {
      deps.log.debug(
        `source cache: no write-back for ${where} (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''})`
      )
    }
    try {
      deps.onOutcome?.(outcome, { shape: target.shape, repoClass: target.repoClass, scope })
    } catch {
      // A metrics hook never fails a write-back.
    }
    return outcome
  }

  /** Objects and bytes reachable from the origin commit but not from the bundle tip; blobs are excluded for a blobless clone. */
  const measureDelta = async (git: GitRunner, tip: string, commit: string, shape: SourceCacheShape) => {
    const filter = shape === 'blobless' ? ['--filter=blob:none'] : []
    const base = ['rev-list', '--objects', '--missing=allow-any', ...filter]
    const objects = Number((await git.raw([...base, '--count', `${tip}..${commit}`])).trim())
    const bytes = Number((await git.raw([...base, '--disk-usage', `${tip}..${commit}`])).trim())
    if (!Number.isSafeInteger(objects) || !Number.isSafeInteger(bytes)) throw new Error('unreadable rev-list count')
    return { objects, bytes }
  }

  const triggerOf = async (request: SourceCacheWriteRequest, commit: string): Promise<SourceCacheWriteTrigger> => {
    const { read } = request
    if (read.kind === 'uncached') return 'miss'
    if (read.kind === 'fallback') {
      return read.reason !== undefined && WRITE_BACK_FALLBACK_REASONS.has(read.reason)
        ? 'fallback'
        : skip(`fallback-${read.reason ?? 'unknown'}`)
    }
    if (read.bundleCreatedAt !== undefined && now() - read.bundleCreatedAt > maxAgeMs) return 'stale'
    if (read.tip === undefined || !OID_RE.test(read.tip)) return skip('no-tip')
    let delta: { objects: number; bytes: number }
    try {
      delta = await measureDelta(request.git, read.tip, commit, request.target.shape)
    } catch (err) {
      if (err instanceof Stop) throw err
      return skip('unmeasured', detailOf(err))
    }
    if (delta.objects > deltaObjects || delta.bytes > deltaBytes) return 'delta'
    return skip('fresh')
  }

  // Gates both paths share: the bucket's lifecycle, and the class the daemon's own clone instruction used (§9 step 2).
  const admit = (target: SourceCacheWriteTarget, credentialed: boolean): void => {
    if (deps.allowWrites && !deps.allowWrites()) skip('lifecycle-missing')
    if (credentialed !== (target.repoClass === 'cred')) skip('class-mismatch')
  }

  const run = async (request: SourceCacheWriteRequest): Promise<SourceCacheWriteOutcome> => {
    const { target, stager, abort } = request
    admit(target, request.credentialed)
    if (stager === undefined) return skip('unsupported-shim')
    const branch = target.ref.slice('refs/heads/'.length)
    let commit: string
    try {
      const origin = (await request.git.raw(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim()
      const local = (await request.git.raw(['rev-parse', '--verify', `${target.ref}^{commit}`])).trim()
      // Only the origin's commit is ever cached, so the agent's own local commits never are.
      if (!OID_RE.test(origin) || origin !== local) return skip('branch-diverged')
      commit = origin
    } catch (err) {
      if (err instanceof Stop) throw err
      return skip('unresolved', detailOf(err))
    }
    const trigger = await triggerOf(request, commit)
    return await publish(target, trigger, stager, abort, () =>
      stager.create(
        { cwd: request.checkout, ref: target.ref, commit, shape: target.shape, maxBytes: deps.limits.maxBundleBytes },
        abort
      )
    )
  }

  // Reserve, sign, upload, verify, commit, retag and move the pointer; `create` is skipped for a pre-staged bundle.
  const publish = async (
    target: SourceCacheWriteTarget,
    trigger: SourceCacheWriteTrigger,
    stager: Pick<SourceCacheBundleStager, 'upload' | 'discard'>,
    abort: AbortSignal | undefined,
    create:
      | (() => Promise<{ handle: string; bytes: number; sha256: string }>)
      | { handle: string; bytes: number; sha256: string }
  ): Promise<SourceCacheWriteOutcome> => {
    const flight = `${target.orgId}\n${target.pointerKey}`
    if (inFlight.has(flight)) return skip('in-flight')
    if (inFlight.size >= maxConcurrent) return skip('busy')
    inFlight.add(flight)
    // Only a handle this call created is discarded here; a pre-staged one belongs to its caller.
    let handle: string | undefined
    let stage: SourceCacheWriteStage = 'create'
    let key: string | undefined
    try {
      const store = deps.store() ?? skip('store-unavailable')
      const pointer = await store.getSourceCacheObject(target.orgId, target.pointerKey)
      if ((pointer?.targetKey ?? null) !== target.observedTargetKey) return skip('pointer-moved')

      let staged: { handle: string; bytes: number; sha256: string }
      if (typeof create === 'function') {
        staged = await create()
        handle = staged.handle
      } else staged = create
      if (staged.bytes > deps.limits.maxBundleBytes) return skip('over-cap')

      stage = 'reserve'
      key = bundleKey({ org: target.orgId, class: target.repoClass, repo: target.repoId, id: newBundleId() })
      const reservedAt = now()
      const reserved = await store.reserveBundle({
        orgId: target.orgId,
        key,
        refHash: refHash(target.ref),
        shape: target.shape,
        bytes: staged.bytes,
        now: reservedAt,
        expiresAt: reservedAt + deps.limits.pendingReservationSeconds * 1000,
        quotaBytes: deps.limits.orgQuotaBytes,
        maxBundleBytes: deps.limits.maxBundleBytes
      })
      if (!reserved.admitted) return skip(`reservation-${reserved.reason}`)

      stage = 'presign'
      const objectKey = key as Parameters<typeof deps.presigner.presignPut>[0]
      const put = await deps.presigner.presignPut(objectKey, {
        contentLength: staged.bytes,
        checksumSha256: staged.sha256
      })

      stage = 'upload'
      const uploaded = await stager.upload({ handle: staged.handle, url: put.url, headers: put.headers }, abort)
      if (uploaded.bytes !== staged.bytes || uploaded.sha256 !== staged.sha256) throw new Error('upload reply mismatch')

      stage = 'verify'
      const head = await deps.objects.head(objectKey)
      // Fail closed: a store that omits the checksum cannot prove the content, so nothing is committed.
      if (!head.exists) throw new Error('object missing after upload')
      if (head.contentLength !== staged.bytes) throw new Error('length mismatch')
      if (head.checksumSha256 !== staged.sha256)
        throw new Error(head.checksumSha256 ? 'checksum mismatch' : 'checksum absent')

      stage = 'commit'
      const committed = await store.commitBundle({ orgId: target.orgId, key, actualBytes: staged.bytes, now: now() })
      if (!committed.committed) throw new Error(committed.reason)

      // A pointer never names a pending-tagged object, so a failed retag leaves the bundle unpointed for the sweep.
      stage = 'retag'
      await deps.objects.putTagging(objectKey, 'ac-cache=live')

      stage = 'pointer'
      const pointed = await store.setSourceCachePointer({
        orgId: target.orgId,
        pointerKey: target.pointerKey,
        bundleKey: key,
        now: now(),
        expectedTargetKey: target.observedTargetKey
      })
      if (!pointed.set) {
        if (pointed.reason === 'pointer-moved') return { kind: 'lost-race', bundleKey: key }
        throw new Error(pointed.reason)
      }
      return { kind: 'written', trigger, bundleKey: key, bytes: staged.bytes }
    } catch (err) {
      if (err instanceof Stop) return err.outcome
      return { kind: 'failed', stage, detail: detailOf(err), ...(key ? { bundleKey: key } : {}) }
    } finally {
      inFlight.delete(flight)
      if (handle !== undefined) await stager.discard(handle, abort).catch(() => undefined)
    }
  }

  const runStaged = async (request: SourceCacheStagedWriteRequest): Promise<SourceCacheWriteOutcome> => {
    const { target, staged } = request
    admit(target, request.credentialed)
    // The pod names the branch it bundled; it must be the one this target was planned for.
    if (staged.branch !== target.ref || !target.ref.startsWith('refs/heads/')) return skip('branch-diverged')
    return await publish(target, request.trigger, request.stager, request.abort, staged)
  }

  const settle = async (
    target: SourceCacheWriteTarget,
    scope: SourceCacheWriteScope,
    work: () => Promise<SourceCacheWriteOutcome>,
    failedAt: SourceCacheWriteStage
  ): Promise<SourceCacheWriteOutcome> => {
    let outcome: SourceCacheWriteOutcome
    try {
      outcome = await work()
    } catch (err) {
      outcome = err instanceof Stop ? err.outcome : { kind: 'failed', stage: failedAt, detail: detailOf(err) }
    }
    try {
      return record(target, outcome, scope)
    } catch {
      return outcome
    }
  }

  return {
    consider: (request) => settle(request.target, 'workspace', () => run(request), 'measure'),
    async considerStaged(request) {
      try {
        return await settle(request.target, 'skill', () => runStaged(request), 'reserve')
      } finally {
        await request.stager.discard(request.staged.handle, request.abort).catch(() => undefined)
      }
    }
  }
}
