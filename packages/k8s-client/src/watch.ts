import { Backoff, systemClock, type Clock } from '@agentconnect.md/connection'
import { K8sApiError, type K8sHttp } from './http.js'

/** The one operability hook the watch loop needs; daemon's ClusterMetrics satisfies it structurally. */
export interface WatchMetrics {
  watchRelist(source: 'status' | 'in_band'): void
}

export interface K8sObject {
  metadata?: { name?: string; uid?: string; resourceVersion?: string; annotations?: Record<string, string> }
}

export interface K8sList<T> {
  metadata?: { resourceVersion?: string }
  items?: T[]
}

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'

export interface WatchEvent<T> {
  type: WatchEventType
  object: T
}

/** What a resumable watch emits: a full snapshot first, then each change. */
export type ResourceEvent<T> =
  | { kind: 'synced'; items: T[] }
  | { kind: 'added'; object: T }
  | { kind: 'modified'; object: T }
  | { kind: 'deleted'; object: T }

export interface WatchOptions {
  /** Collection path, e.g. `/apis/.../namespaces/org-x/sandboxclaims`. */
  path: string
  labelSelector?: string
  /** Server-side watch timeout; the loop reconnects when it elapses. */
  timeoutSeconds?: number
  signal?: AbortSignal
  clock?: Clock
  backoff?: Backoff
  log?: { debug?: (message: string) => void; warn?: (message: string) => void }
  /** Operability counters; a re-list is invisible in logs alone at any real volume. */
  metrics?: WatchMetrics
}

/** Clock-driven delay that leaves no listener behind — a long outage retries often
 *  on one long-lived signal, so the timer path must unregister too. */
function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      clock.clearTimeout(handle)
      resolve()
    }
    const handle = clock.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    // Closes the race between the pre-check above and listener registration.
    if (signal?.aborted) onAbort()
  })
}

/** List-then-watch with resume — the one part of a hand-rolled client that is easy to
 *  get wrong. The LIST establishes both the snapshot and the `resourceVersion` the watch
 *  resumes from, so nothing in between is lost. `allowWatchBookmarks` keeps an idle
 *  watch's resume point fresh; without it a quiet resource drifts far enough behind to
 *  be Expired on reconnect. A 410 / Expired resume point is answered by re-LISTing, not
 *  by failing — which is why `list` is a required verb here. A cleanly closed stream is
 *  the server-side timeout and reconnects at once; a failed connection backs off.
 *  Every (re)sync yields a `synced` snapshot so consumers converge rather than assume
 *  incremental continuity across a gap. */
export async function* watchCollection<T extends K8sObject>(
  http: K8sHttp,
  options: WatchOptions
): AsyncGenerator<ResourceEvent<T>> {
  const clock = options.clock ?? systemClock
  const backoff = options.backoff ?? new Backoff()
  let resourceVersion: string | undefined

  while (!options.signal?.aborted) {
    if (resourceVersion === undefined) {
      try {
        const list = await http.json<K8sList<T>>({
          method: 'GET',
          path: options.path,
          query: { ...(options.labelSelector ? { labelSelector: options.labelSelector } : {}) },
          ...(options.signal ? { signal: options.signal } : {})
        })
        resourceVersion = list.metadata?.resourceVersion
        backoff.reset()
        yield { kind: 'synced', items: list.items ?? [] }
      } catch (err) {
        if (options.signal?.aborted) return
        options.log?.warn?.(`k8s: list ${options.path} failed (${(err as Error).message})`)
        await sleep(clock, backoff.next(), options.signal)
        continue
      }
      if (resourceVersion === undefined) {
        // A list without a resourceVersion cannot seed a watch; retry the list
        // rather than starting an unresumable stream from "now".
        options.log?.warn?.(`k8s: list ${options.path} returned no resourceVersion`)
        await sleep(clock, backoff.next(), options.signal)
        continue
      }
    }

    try {
      const events = http.lines<WatchEvent<T>>({
        method: 'GET',
        path: options.path,
        query: {
          watch: true,
          allowWatchBookmarks: true,
          resourceVersion,
          timeoutSeconds: options.timeoutSeconds ?? 300,
          ...(options.labelSelector ? { labelSelector: options.labelSelector } : {})
        },
        ...(options.signal ? { signal: options.signal } : {})
      })
      for await (const event of events) {
        if (options.signal?.aborted) return
        const version = event.object?.metadata?.resourceVersion
        if (version) resourceVersion = version
        backoff.reset()
        if (event.type === 'BOOKMARK') continue
        if (event.type === 'ERROR') {
          // The stream carries its rejection in-band; `Expired` here means the same
          // as a 410 status and is handled by dropping the resume point.
          const status = event.object as unknown as { reason?: string; message?: string; code?: number }
          const error = new K8sApiError(status.code ?? 0, status.reason, status.message ?? 'watch error')
          if (!error.isExpired) throw error
          options.metrics?.watchRelist('in_band')
          options.log?.debug?.(`k8s: watch ${options.path} expired in-band — re-listing`)
          resourceVersion = undefined
          break
        }
        if (event.type === 'ADDED') yield { kind: 'added', object: event.object }
        else if (event.type === 'MODIFIED') yield { kind: 'modified', object: event.object }
        else if (event.type === 'DELETED') yield { kind: 'deleted', object: event.object }
      }
      // A cleanly ended stream is the server-side timeout: reconnect immediately,
      // resuming from the last observed version.
    } catch (err) {
      if (options.signal?.aborted) return
      if (err instanceof K8sApiError && err.isExpired) {
        options.metrics?.watchRelist('status')
        options.log?.debug?.(`k8s: watch ${options.path} resume point expired — re-listing`)
        resourceVersion = undefined
        continue
      }
      options.log?.warn?.(`k8s: watch ${options.path} failed (${(err as Error).message})`)
      await sleep(clock, backoff.next(), options.signal)
    }
  }
}
