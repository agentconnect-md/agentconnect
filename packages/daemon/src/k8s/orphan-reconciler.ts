import { systemClock, type Clock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { AC_LABEL_AGENT, AC_LABEL_SESSION, claimAdmittedAt, sessionSandboxSubject } from './sandbox-identity.js'
import { probeClaimExpiry } from './probe-claim.js'
import type { Sandbox, SandboxApi, SandboxClaim } from './sandbox-api.js'

/**
 * The pool's orphan reconciler: ONE sweep that finds sandbox objects nobody will ever clean up and
 * removes them, instead of every teardown path carrying its own durable obligation to survive a
 * member dying mid-way (k8s-daemon-pool.md §4).
 *
 * It runs as a Kubernetes CronJob (`agentconnect-daemon reconcile --once`), not as a timer inside
 * every member: the schedule, the mutual exclusion (`concurrencyPolicy: Forbid`) and the failure
 * reporting are the cluster's, so the daemon keeps no scheduler, no jitter, and no lease.
 *
 * Safety over completeness. Deleting a claim deletes the workspace volume, so a candidate is
 * collected only when it is PROVABLY orphaned: the control plane no longer knows its agent and the
 * object is older than the grace period; a probe claim is past its own window; a Sandbox has no
 * claim and no live agent; a session pod's session row is provably gone from the shared store
 * (git-workspace-model.md §11) while its agent lives. An object of a live agent is never touched —
 * not even a claimless Sandbox — an unreadable answer fails the sweep, and a session nobody can
 * answer for reads as live. Ships dry-run: it logs and counts until the deployment enables deletion.
 *
 * The absence proof is a SNAPSHOT, so it is fenced by the claim's own version rather than trusted on
 * its own. A member stamps every claim it admits AND every claim it currently holds a launch for
 * (`agentconnect.md/last-admitted-at`, refreshed on a tick well inside the grace), so the stamp reads
 * "last seen in use by a member" rather than "last admitted" — a launch served from a member's registry
 * touches no API, so an admission-only marker would have left a claim in use looking untouched. That
 * does two things here: the grace runs from that stamp as much as from creation, so a claim a member is
 * using, or one a new session re-admitted, is young again and no candidate at all; and the stamp's write
 * moves the claim's resourceVersion, so a use that
 * landed after this sweep listed the object makes the preconditioned delete below fail rather than
 * take a live session's pod and volume. Admission and collection share one object version.
 */

/** Deployment-owned settings, env like the rest of the plane's; absent ⇒ the default below. */
export const ORPHAN_GRACE_ENV = 'AC_K8S_ORPHAN_GRACE_MS'
/** Deletion is opt-in: `1`/`true` collects, anything else only reports. */
export const ORPHAN_DELETE_ENV = 'AC_K8S_ORPHAN_DELETE'
export const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrphanReconcilerSettings {
  graceMs: number
  deleteEnabled: boolean
}

export function resolveOrphanReconcilerSettings(env: NodeJS.ProcessEnv = process.env): OrphanReconcilerSettings {
  const raw = env[ORPHAN_GRACE_ENV]?.trim()
  let graceMs = DEFAULT_ORPHAN_GRACE_MS
  if (raw) {
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${ORPHAN_GRACE_ENV} is not a positive integer: ${raw}`)
    graceMs = value
  }
  const flag = env[ORPHAN_DELETE_ENV]?.trim().toLowerCase()
  return { graceMs, deleteEnabled: flag === '1' || flag === 'true' }
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
  /** Which of these agents the control plane still knows; a throw fails the sweep. */
  liveAgents: (agentIds: string[]) => Promise<Set<string>>
  /** Which of these session pods still have a session row, as `<agentId>/<leaf>` subjects; absent or throwing ⇒ every session pod reads as live. */
  liveSessionLeaves?: (sessions: Array<{ agentId: string; leaf: string }>) => Promise<Set<string>>
  settings: OrphanReconcilerSettings
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/** A collectable object: what it is, which agent it belongs to, and how to delete exactly it. */
interface Candidate {
  kind: 'claim' | 'probe-claim' | 'sandbox'
  name: string
  uid: string
  resourceVersion?: string
  agentId: string
  /** The session leaf a per-session pod carries (`agentconnect.md/session`); absent for the agent's own pod. */
  sessionLeaf?: string
  /** Epoch ms, NaN when the object did not say — an age nobody knows never passes the grace. */
  createdAt: number
  /** Epoch ms of the claim's last admission stamp, absent when it carries none — a Sandbox never does. */
  admittedAt?: number
  /** A probe claim's own window, stamped by the probe that made it. */
  probeExpiresAt?: number
}

export class OrphanReconciler {
  private readonly clock: Clock
  private sandboxListDenied = false

  constructor(private readonly deps: OrphanReconcilerDeps) {
    this.clock = deps.clock ?? systemClock
  }

  /** One sweep. Resolves undefined when it failed — the CronJob turns that into a non-zero exit. */
  async sweep(): Promise<OrphanSweepSummary | undefined> {
    try {
      return await this.runSweep()
    } catch (err) {
      this.deps.log.warn(`k8s orphans: sweep failed — ${(err as Error).message}`)
      return undefined
    }
  }

  private async runSweep(): Promise<OrphanSweepSummary> {
    const { settings, log } = this.deps
    const now = this.clock.now()
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
    // Session pods of LIVE agents are asked about once per run; an agent's death already collects its sessions' pods.
    const liveSessions = await this.liveSessions(
      candidates.filter((c) => c.kind !== 'probe-claim' && c.sessionLeaf !== undefined && live.has(c.agentId))
    )
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
      if (!UUID.test(candidate.agentId)) {
        summary.skippedLive += 1
        continue
      }
      if (live.has(candidate.agentId)) {
        // A live agent's own pod is never touched; its session pod only when its row is PROVABLY gone (§11).
        const leaf = candidate.sessionLeaf
        if (
          leaf === undefined ||
          liveSessions === undefined ||
          liveSessions.has(sessionSandboxSubject(candidate.agentId, leaf))
        ) {
          summary.skippedLive += 1
          continue
        }
      }
      // The object's own age IS the grace: a one-shot run has no memory of an earlier sweep, and this
      // is the clock that matters anyway — no in-flight creation can still be racing the CP's write.
      // Age runs from the LATER of creation and the last time a member admitted or refreshed this claim,
      // because one in use — or one a returning session re-admitted — is young again, and only the stamp says so.
      const since =
        candidate.admittedAt === undefined ? candidate.createdAt : Math.max(candidate.createdAt, candidate.admittedAt)
      if (!(Number.isFinite(since) && now - since >= settings.graceMs)) {
        summary.skippedGrace += 1
        continue
      }
      orphans.push(candidate)
    }
    summary.orphaned = orphans.length
    for (const orphan of orphans) {
      if (!settings.deleteEnabled) {
        log.info(`k8s orphans: would delete ${orphan.kind} ${orphan.name} (${ownerOf(orphan)}) — dry run`)
        continue
      }
      try {
        const current = await this.deleteCurrent(orphan)
        if (current) {
          summary.deleted += 1
          log.info(`k8s orphans: deleted ${orphan.kind} ${orphan.name} (${ownerOf(orphan)})`)
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

  // Fail-closed: no store to ask, or a store that will not answer, keeps every session pod of a live agent.
  private async liveSessions(sessions: Candidate[]): Promise<Set<string> | undefined> {
    if (sessions.length === 0) return new Set()
    const ask = this.deps.liveSessionLeaves
    if (!ask) return undefined
    try {
      return await ask(sessions.map((c) => ({ agentId: c.agentId, leaf: c.sessionLeaf! })))
    } catch (err) {
      this.deps.log.warn(
        `k8s orphans: could not ask which sessions still exist — keeping every session pod (${(err as Error).message})`
      )
      return undefined
    }
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

/** Who an orphan belonged to, for the log line: its agent, and its session leaf for a session pod. */
function ownerOf(orphan: Candidate): string {
  return orphan.sessionLeaf === undefined
    ? `agent ${orphan.agentId}`
    : `agent ${orphan.agentId}, session ${orphan.sessionLeaf}`
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
  const sessionLeaf = labels?.[AC_LABEL_SESSION]
  const resourceVersion = object.metadata?.resourceVersion
  const probeExpiresAt = kind === 'claim' ? probeClaimExpiry(object as SandboxClaim) : undefined
  // Only a claim is admitted; a Sandbox is the controller's object and nothing stamps it.
  const admittedAt = kind === 'claim' ? claimAdmittedAt(object.metadata?.annotations) : Number.NaN
  return {
    kind: probeExpiresAt === undefined ? kind : 'probe-claim',
    name,
    uid,
    ...(resourceVersion ? { resourceVersion } : {}),
    agentId,
    ...(sessionLeaf ? { sessionLeaf } : {}),
    ...(Number.isFinite(admittedAt) ? { admittedAt } : {}),
    createdAt: Date.parse(object.metadata?.creationTimestamp ?? ''),
    ...(probeExpiresAt === undefined ? {} : { probeExpiresAt })
  }
}
