import {
  evaluateSourceCacheLifecycle,
  multipartAbortLifecycleRule,
  sourceCacheLifecycleRules,
  sourceCacheSrcPrefix,
  type SourceCacheObjectClient
} from '@agentconnect.md/object-store'

// Whether the bucket expires `pending` objects under src/ (source-cache.md §10), and no sooner than a live transfer link needs.

/** `short`: some rule expires pending objects before a reused download's link would lapse. */
export type LifecycleStatus = 'present' | 'missing' | 'short' | 'unknown'

/** How often the control plane re-reads the bucket's lifecycle configuration. */
export const LIFECYCLE_RECHECK_MS = 10 * 60_000

export interface LifecycleGate {
  /** The last known status; `unknown` until the first read lands, and whenever the read itself fails. */
  status(): LifecycleStatus
  /** Whether transfers may run: a failed read leaves them on, an affirmatively missing or short rule does not. */
  enabled(): boolean
  /** Whether uploads may go in parts: transfers run, and no read showed the abort rule for unfinished uploads missing. */
  multipart(): boolean
  /** Read the configuration now; never throws. */
  check(): Promise<LifecycleStatus>
  start(): void
  stop(): void
}

export function createLifecycleGate(deps: {
  objects: Pick<SourceCacheObjectClient, 'getBucketLifecycle'>
  prefix: string
  /** The shortest `pending` window, in days, transfers stay correct under. */
  minimumPendingDays: number
  log: { info(message: string): void; warn(message: string): void }
  recheckMs?: number
}): LifecycleGate {
  let status: LifecycleStatus = 'unknown'
  let multipartAbort: boolean | undefined
  let timer: NodeJS.Timeout | undefined
  const src = sourceCacheSrcPrefix(deps.prefix)

  const check = async (): Promise<LifecycleStatus> => {
    let next: LifecycleStatus
    try {
      const lifecycle = await deps.objects.getBucketLifecycle()
      const evaluation =
        lifecycle.kind === 'rules' ? evaluateSourceCacheLifecycle(lifecycle.xml, deps.prefix) : undefined
      const shortest = evaluation?.pendingShortestDays
      next = !evaluation?.pending
        ? 'missing'
        : shortest !== undefined && shortest < deps.minimumPendingDays
          ? 'short'
          : 'present'
      if (next === 'missing' && status !== 'missing') {
        deps.log.warn(
          `file transfer: the bucket has no enabled lifecycle rule expiring ac-cache=pending under ${src}; transfers are disabled until it does. Merge these rules into the bucket's lifecycle configuration: ${JSON.stringify(sourceCacheLifecycleRules(deps.prefix))}`
        )
      } else if (next === 'short' && status !== 'short') {
        deps.log.warn(
          `file transfer: a lifecycle rule expires ac-cache=pending objects under ${src} after ${shortest} day(s), shorter than the ${deps.minimumPendingDays} a reused download and its link need; transfers are disabled until every such rule keeps them at least that long`
        )
      } else if (next === 'present' && status !== 'present') {
        deps.log.info(`file transfer: bucket lifecycle rules for ${src} are present`)
      }
      // Only while transfers run does the abort rule decide anything: whether an upload may go in parts.
      const abort = evaluation?.multipartAbort ?? false
      if (next === 'present' && !abort && (status !== 'present' || multipartAbort !== false)) {
        deps.log.warn(
          `file transfer: the bucket has no enabled lifecycle rule aborting unfinished multipart uploads under ${src}; uploads larger than one part are refused until it does. Add this rule: ${JSON.stringify(multipartAbortLifecycleRule(deps.prefix))}`
        )
      }
      multipartAbort = abort
    } catch (err) {
      next = 'unknown'
      if (status !== 'unknown')
        deps.log.warn(
          `file transfer: could not read the bucket lifecycle configuration (${err instanceof Error ? err.message : 'error'}); the control plane needs s3:GetLifecycleConfiguration to verify the ${src} rules`
        )
    }
    status = next
    return next
  }

  return {
    status: () => status,
    enabled: () => status === 'present' || status === 'unknown',
    multipart: () => (status === 'present' || status === 'unknown') && multipartAbort !== false,
    check,
    start() {
      if (timer) return
      void check()
      timer = setInterval(() => void check(), deps.recheckMs ?? LIFECYCLE_RECHECK_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
