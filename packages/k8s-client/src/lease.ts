import { systemClock, type Clock } from '@agentconnect.md/connection'
import { K8sApiError, type K8sHttp } from './http.js'

/** The coordination.k8s.io/v1 Lease fields this elector reads and writes. */
interface Lease {
  metadata?: { name?: string; namespace?: string; resourceVersion?: string }
  spec?: {
    holderIdentity?: string
    leaseDurationSeconds?: number
    acquireTime?: string
    renewTime?: string
    leaseTransitions?: number
  }
}

export interface LeaseElectorOptions {
  namespace: string
  leaseName: string
  /** Stable per-replica identity, e.g. the pod name. */
  identity: string
  /** Another candidate may take over after the holder misses renewals for this long. */
  leaseDurationSeconds?: number
  /** How often the holder renews and followers re-check; default leaseDuration/3. */
  renewIntervalMs?: number
  clock?: Clock
  log?: { debug?: (message: string) => void; warn?: (message: string) => void }
  onStartedLeading(): void
  onStoppedLeading(): void
}

const DEFAULT_LEASE_DURATION_SECONDS = 15

/** Clock-driven abortable delay; mirrors the watch loop's listener-safe sleep. */
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
    if (signal?.aborted) onAbort()
  })
}

/**
 * Single-holder election over one coordination.k8s.io Lease: create when absent,
 * renew while holding, take over only after the holder's lease duration lapses.
 * Every write carries resourceVersion, so a lost race is a 409, never a split.
 */
export class LeaseElector {
  private readonly namespace: string
  private readonly leaseName: string
  private readonly identity: string
  private readonly leaseDurationSeconds: number
  private readonly renewIntervalMs: number
  private readonly clock: Clock
  private readonly log: LeaseElectorOptions['log']
  private readonly onStartedLeading: () => void
  private readonly onStoppedLeading: () => void

  private leading = false
  private lastRenewMs = 0
  private readonly stopController = new AbortController()

  constructor(
    private readonly http: K8sHttp,
    options: LeaseElectorOptions
  ) {
    this.namespace = options.namespace
    this.leaseName = options.leaseName
    this.identity = options.identity
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? DEFAULT_LEASE_DURATION_SECONDS
    this.renewIntervalMs = options.renewIntervalMs ?? Math.floor((this.leaseDurationSeconds * 1000) / 3)
    this.clock = options.clock ?? systemClock
    this.log = options.log
    this.onStartedLeading = options.onStartedLeading
    this.onStoppedLeading = options.onStoppedLeading
  }

  get isLeader(): boolean {
    return this.leading
  }

  private get path(): string {
    return `/apis/coordination.k8s.io/v1/namespaces/${this.namespace}/leases/${this.leaseName}`
  }

  /** Runs the acquire/renew loop until the signal aborts or stop() is called. */
  async start(signal?: AbortSignal): Promise<void> {
    const stop = this.stopController.signal
    const aborted = (): boolean => stop.aborted || signal?.aborted === true
    while (!aborted()) {
      try {
        await this.tick()
      } catch (error) {
        this.log?.warn?.(`lease tick failed: ${String(error)}`)
        this.demoteIfExpired()
      }
      await sleep(this.clock, this.renewIntervalMs, signal ?? stop)
      if (signal?.aborted) break
    }
    if (this.leading) await this.release()
  }

  /** Aborts the loop and releases the lease when held. */
  async stop(): Promise<void> {
    this.stopController.abort()
    if (this.leading) await this.release()
  }

  private async tick(): Promise<void> {
    let lease: Lease | undefined
    try {
      lease = await this.http.json<Lease>({ method: 'GET', path: this.path })
    } catch (error) {
      if (!(error instanceof K8sApiError) || !error.isNotFound) throw error
    }
    const now = this.clock.now()
    if (!lease) {
      await this.write('POST', `/apis/coordination.k8s.io/v1/namespaces/${this.namespace}/leases`, {
        metadata: { name: this.leaseName, namespace: this.namespace },
        spec: this.heldSpec(now, 0)
      })
      return
    }
    const spec = lease.spec ?? {}
    if (spec.holderIdentity === this.identity) {
      await this.write('PUT', this.path, {
        metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: lease.metadata?.resourceVersion },
        spec: { ...this.heldSpec(now, spec.leaseTransitions ?? 0), acquireTime: spec.acquireTime }
      })
      return
    }
    // Someone else holds it — we are (or just became) a follower.
    this.demote()
    const renewedAt = spec.renewTime ? Date.parse(spec.renewTime) : 0
    const durationMs = (spec.leaseDurationSeconds ?? this.leaseDurationSeconds) * 1000
    if (now - renewedAt <= durationMs) return
    await this.write('PUT', this.path, {
      metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: lease.metadata?.resourceVersion },
      spec: this.heldSpec(now, (spec.leaseTransitions ?? 0) + 1)
    })
  }

  private heldSpec(nowMs: number, transitions: number): Lease['spec'] {
    const stamp = new Date(nowMs).toISOString()
    return {
      holderIdentity: this.identity,
      leaseDurationSeconds: this.leaseDurationSeconds,
      acquireTime: stamp,
      renewTime: stamp,
      leaseTransitions: transitions
    }
  }

  /** A successful write means we hold the lease as of this tick. */
  private async write(method: 'POST' | 'PUT', path: string, body: Lease): Promise<void> {
    try {
      await this.http.json<Lease>({ method, path, body })
    } catch (error) {
      if (error instanceof K8sApiError && (error.isConflict || error.isAlreadyExists)) {
        this.log?.debug?.('lease write lost an optimistic-concurrency race; will re-read next tick')
        this.demoteIfExpired()
        return
      }
      throw error
    }
    this.lastRenewMs = this.clock.now()
    if (!this.leading) {
      this.leading = true
      this.onStartedLeading()
    }
  }

  /** Renewal has been failing: only surrender once our own lease window lapsed. */
  private demoteIfExpired(): void {
    if (!this.leading) return
    if (this.clock.now() - this.lastRenewMs > this.leaseDurationSeconds * 1000) this.demote()
  }

  private demote(): void {
    if (!this.leading) return
    this.leading = false
    this.onStoppedLeading()
  }

  /** Best-effort handoff so the next candidate need not wait out the full duration. */
  private async release(): Promise<void> {
    try {
      const lease = await this.http.json<Lease>({ method: 'GET', path: this.path })
      if (lease.spec?.holderIdentity !== this.identity) return
      await this.http.json<Lease>({
        method: 'PUT',
        path: this.path,
        body: {
          metadata: {
            name: this.leaseName,
            namespace: this.namespace,
            resourceVersion: lease.metadata?.resourceVersion
          },
          // TODO: clock-skew and fencing exotica are deliberately out of scope for v1.
          spec: {
            holderIdentity: '',
            leaseDurationSeconds: this.leaseDurationSeconds,
            leaseTransitions: lease.spec?.leaseTransitions
          }
        }
      })
    } catch (error) {
      this.log?.warn?.(`lease release failed (harmless — next candidate waits out the duration): ${String(error)}`)
    } finally {
      this.demote()
    }
  }
}
