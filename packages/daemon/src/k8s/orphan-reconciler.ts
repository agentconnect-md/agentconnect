import { systemClock, type Clock, type TimerHandle } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { AC_LABEL_AGENT } from './driver.js'
import { probeClaimExpiry } from './probe-claim.js'
import type { Sandbox, SandboxApi, SandboxClaim } from './sandbox-api.js'

/**
 * The pool's orphan reconciler: a periodic sweep that finds sandbox objects nobody will ever
 * clean up and removes them, instead of every teardown path carrying its own durable obligation
 * to survive a member dying mid-way (k8s-daemon-pool.md §4).
 *
 * Safety over completeness. Deleting a claim deletes the workspace volume, so a candidate is
 * collected only when it is PROVABLY orphaned: the control plane no longer knows its agent, and
 * has not for at least the grace period as observed by this member across sweeps; a probe claim
 * is past its own window; a Sandbox has no claim and no live agent. An object of a live agent
 * is never touched — not even a claimless Sandbox — and an unreadable answer skips the sweep.
 * Ships dry-run: it logs and counts until the deployment enables deletion.
 */

/** Deployment-owned settings, env like the rest of the plane's; absent ⇒ the defaults below. */
export const ORPHAN_SWEEP_INTERVAL_ENV = 'AC_K8S_ORPHAN_SWEEP_INTERVAL_MS'
export const ORPHAN_GRACE_ENV = 'AC_K8S_ORPHAN_GRACE_MS'
/** Deletion is opt-in: `1`/`true` collects, anything else only reports. */
export const ORPHAN_DELETE_ENV = 'AC_K8S_ORPHAN_DELETE'
export const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000
export const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000
/** Name of the single-holder lease in the shared store; one member sweeps at a time. */
export const ORPHAN_SWEEP_LEASE = 'k8s-orphan-sweep'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrphanReconcilerSettings {
  intervalMs: number
  graceMs: number
  deleteEnabled: boolean
}

export function resolveOrphanReconcilerSettings(env: NodeJS.ProcessEnv = process.env): OrphanReconcilerSettings {
  const positive = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is not a positive integer: ${raw}`)
    return value
  }
  const flag = env[ORPHAN_DELETE_ENV]?.trim().toLowerCase()
  return {
    intervalMs: positive(ORPHAN_SWEEP_INTERVAL_ENV, DEFAULT_ORPHAN_SWEEP_INTERVAL_MS),
    graceMs: positive(ORPHAN_GRACE_ENV, DEFAULT_ORPHAN_GRACE_MS),
    deleteEnabled: flag === '1' || flag === 'true'
  }
}

/** One sweep's counters, also the shape of its summary log line. */
export interface OrphanSweepSummary {
  candidates: number
  orphaned: number
  deleted: number
  skippedLive: number
  skippedGrace: number
  failed: number
}

export interface OrphanReconcilerDeps {
  api: Pick<SandboxApi, 'listClaims' | 'deleteClaimIfCurrent' | 'listSandboxes' | 'deleteSandboxIfCurrent'>
  /** Take or renew the install-wide sweep lease for `ttlMs`; false ⇒ another member is sweeping. */
  acquireLease: (ttlMs: number, now: number) => boolean
  /** Which of these agents the control plane still knows; a throw skips the sweep. */
  liveAgents: (agentIds: string[]) => Promise<Set<string>>
  settings: OrphanReconcilerSettings
  clock?: Clock
  /** Uniform in [0, 1); spreads the members' timers so a rollout does not line them up. */
  jitter?: () => number
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/** A collectable object: what it is, which agent it belongs to, and how to delete exactly it. */
interface Candidate {
  kind: 'claim' | 'probe-claim' | 'sandbox'
  name: string
  uid: string
  resourceVersion?: string
  agentId: string
  /** Epoch ms, NaN when the object did not say — an age nobody knows never passes the grace. */
  createdAt: number
  /** A probe claim's own window, stamped by the probe that made it. */
  probeExpiresAt?: number
}

export class OrphanReconciler {
  private readonly clock: Clock
  private readonly jitter: () => number
  private timer?: TimerHandle
  private stopped = false
  private inFlight?: Promise<OrphanSweepSummary | undefined>
  /** When this member first saw each object's agent missing, by uid; forgotten once seen live. */
  private readonly missingSince = new Map<string, number>()
  private sandboxListDenied = false

  constructor(private readonly deps: OrphanReconcilerDeps) {
    this.clock = deps.clock ?? systemClock
    this.jitter = deps.jitter ?? Math.random
  }

  /** Arm the periodic sweep; the first one is a jittered interval away, like every later one. */
  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.stopped) return
    // ±25% around the interval: members drift apart, and the lease holder still renews well
    // inside a lease that lasts three intervals.
    const delay = Math.round(this.deps.settings.intervalMs * (0.75 + 0.5 * this.jitter()))
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      void this.sweep().finally(() => this.arm())
    }, delay)
    // A sweep is housekeeping: it must never be what keeps a stopping process alive.
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** One sweep. Resolves undefined when this member does not hold the lease or the sweep was skipped. */
  sweep(): Promise<OrphanSweepSummary | undefined> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runSweep()
      .catch((err: unknown) => {
        this.deps.log.warn(`k8s orphans: sweep failed — ${(err as Error).message}`)
        return undefined
      })
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  private async runSweep(): Promise<OrphanSweepSummary | undefined> {
    const { settings, log } = this.deps
    const now = this.clock.now()
    if (!this.deps.acquireLease(settings.intervalMs * 3, now)) {
      log.debug?.('k8s orphans: another member holds the sweep lease')
      return undefined
    }
    const claims = await this.deps.api.listClaims()
    const sandboxes = await this.listSandboxes()
    const bound = new Set(claims.map((claim) => claim.status?.sandbox?.name).filter((name) => name !== undefined))
    const candidates: Candidate[] = []
    for (const claim of claims) {
      const candidate = candidateOf(claim, 'claim')
      if (candidate) candidates.push(candidate)
    }
    for (const sandbox of sandboxes) {
      const name = sandbox.metadata?.name
      if (!name || bound.has(name)) continue
      const candidate = candidateOf(sandbox, 'sandbox')
      if (candidate) candidates.push(candidate)
    }
    const summary: OrphanSweepSummary = {
      candidates: candidates.length,
      orphaned: 0,
      deleted: 0,
      skippedLive: 0,
      skippedGrace: 0,
      failed: 0
    }
    // Probe agents are member-local and never known to the control plane, so they are not asked about.
    const askable = [
      ...new Set(candidates.filter((c) => c.kind !== 'probe-claim' && UUID.test(c.agentId)).map((c) => c.agentId))
    ]
    const live = askable.length > 0 ? await this.deps.liveAgents(askable) : new Set<string>()
    const seen = new Set<string>()
    const orphans: Candidate[] = []
    for (const candidate of candidates) {
      if (candidate.kind === 'probe-claim') {
        // Inside its own window the probe may still be running; an unreadable window is never up.
        const expiresAt = candidate.probeExpiresAt ?? Number.NaN
        if (!Number.isFinite(expiresAt) || expiresAt > now) summary.skippedGrace += 1
        else orphans.push(candidate)
        continue
      }
      // An id the control plane could not even be asked about is treated as live: never guess.
      if (!UUID.test(candidate.agentId) || live.has(candidate.agentId)) {
        summary.skippedLive += 1
        continue
      }
      seen.add(candidate.uid)
      const firstMissing = this.missingSince.get(candidate.uid) ?? now
      this.missingSince.set(candidate.uid, firstMissing)
      // Both clocks must agree: missing across this member's sweeps for the grace, AND old enough
      // that no in-flight creation could still be racing the control plane's own write.
      const aged = Number.isFinite(candidate.createdAt) && now - candidate.createdAt >= settings.graceMs
      if (now - firstMissing < settings.graceMs || !aged) {
        summary.skippedGrace += 1
        continue
      }
      orphans.push(candidate)
    }
    for (const uid of [...this.missingSince.keys()]) if (!seen.has(uid)) this.missingSince.delete(uid)
    summary.orphaned = orphans.length
    for (const orphan of orphans) {
      if (!settings.deleteEnabled) {
        log.info(`k8s orphans: would delete ${orphan.kind} ${orphan.name} (agent ${orphan.agentId}) — dry run`)
        continue
      }
      try {
        const current = await this.deleteCurrent(orphan)
        if (current) {
          summary.deleted += 1
          log.info(`k8s orphans: deleted ${orphan.kind} ${orphan.name} (agent ${orphan.agentId})`)
        } else {
          log.info(`k8s orphans: ${orphan.kind} ${orphan.name} was replaced since it was listed — left alone`)
        }
      } catch (err) {
        summary.failed += 1
        log.warn(`k8s orphans: deleting ${orphan.kind} ${orphan.name} failed — ${(err as Error).message}`)
      }
    }
    log.info(
      `k8s orphans: swept ${summary.candidates} candidates — orphaned=${summary.orphaned} deleted=${summary.deleted} ` +
        `skipped-live=${summary.skippedLive} skipped-grace=${summary.skippedGrace} failed=${summary.failed}` +
        (settings.deleteEnabled ? '' : ' (dry run)')
    )
    return summary
  }

  // Listing Sandboxes needs a verb the claim path never did; a Role without it just narrows the sweep to claims.
  private async listSandboxes(): Promise<Sandbox[]> {
    try {
      return await this.deps.api.listSandboxes()
    } catch (err) {
      if (!(err instanceof K8sApiError) || err.status !== 403) throw err
      if (!this.sandboxListDenied)
        this.deps.log.warn(`k8s orphans: listing sandboxes is not permitted — sweeping claims only`)
      this.sandboxListDenied = true
      return []
    }
  }

  private deleteCurrent(orphan: Candidate): Promise<boolean> {
    const preconditions = {
      uid: orphan.uid,
      ...(orphan.resourceVersion ? { resourceVersion: orphan.resourceVersion } : {})
    }
    return orphan.kind === 'sandbox'
      ? this.deps.api.deleteSandboxIfCurrent(orphan.name, preconditions)
      : this.deps.api.deleteClaimIfCurrent(orphan.name, preconditions)
  }
}

/** The install's objects carry the agent label on their pod metadata; anything else is not ours. */
function candidateOf(object: SandboxClaim | Sandbox, kind: 'claim' | 'sandbox'): Candidate | undefined {
  const name = object.metadata?.name
  const uid = object.metadata?.uid
  if (!name || !uid) return undefined
  const labels =
    kind === 'claim'
      ? (object as SandboxClaim).spec?.additionalPodMetadata?.labels
      : (object as Sandbox).spec?.podTemplate?.metadata?.labels
  const agentId = labels?.[AC_LABEL_AGENT]
  if (!agentId) return undefined
  const resourceVersion = object.metadata?.resourceVersion
  const probeExpiresAt = kind === 'claim' ? probeClaimExpiry(object as SandboxClaim) : undefined
  return {
    kind: probeExpiresAt === undefined ? kind : 'probe-claim',
    name,
    uid,
    ...(resourceVersion ? { resourceVersion } : {}),
    agentId,
    createdAt: Date.parse(object.metadata?.creationTimestamp ?? ''),
    ...(probeExpiresAt === undefined ? {} : { probeExpiresAt })
  }
}
