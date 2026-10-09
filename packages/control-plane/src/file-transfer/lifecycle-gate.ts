import {
  evaluateSourceCacheLifecycle,
  sourceCacheLifecycleRules,
  sourceCacheSrcPrefix,
  type SourceCacheObjectClient
} from '@agentconnect.md/object-store'

// Whether the bucket expires `pending` objects under src/ (source-cache.md §10); without that rule no transfer is ever collected.

export type LifecycleStatus = 'present' | 'missing' | 'unknown'

/** How often the control plane re-reads the bucket's lifecycle configuration. */
export const LIFECYCLE_RECHECK_MS = 10 * 60_000

export interface LifecycleGate {
  /** The last known status; `unknown` until the first read lands, and whenever the read itself fails. */
  status(): LifecycleStatus
  /** Read the configuration now; never throws. */
  check(): Promise<LifecycleStatus>
  start(): void
  stop(): void
}

export function createLifecycleGate(deps: {
  objects: Pick<SourceCacheObjectClient, 'getBucketLifecycle'>
  prefix: string
  log: { info(message: string): void; warn(message: string): void }
  recheckMs?: number
}): LifecycleGate {
  let status: LifecycleStatus = 'unknown'
  let timer: NodeJS.Timeout | undefined
  const src = sourceCacheSrcPrefix(deps.prefix)

  const check = async (): Promise<LifecycleStatus> => {
    let next: LifecycleStatus
    try {
      const lifecycle = await deps.objects.getBucketLifecycle()
      const pending = lifecycle.kind === 'rules' && evaluateSourceCacheLifecycle(lifecycle.xml, deps.prefix).pending
      next = pending ? 'present' : 'missing'
      if (next === 'missing' && status !== 'missing') {
        deps.log.warn(
          `file transfer: the bucket has no enabled lifecycle rule expiring ac-cache=pending under ${src}; transfers are disabled until it does. Merge these rules into the bucket's lifecycle configuration: ${JSON.stringify(sourceCacheLifecycleRules(deps.prefix))}`
        )
      } else if (next === 'present' && status !== 'present') {
        deps.log.info(`file transfer: bucket lifecycle rules for ${src} are present`)
      }
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
