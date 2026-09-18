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
 * One live agent's objects ARE collectable: one the control plane no longer places on this pool. No
 * member holds its duty, so none suspends its pods or sweeps its sessions, and the daemon that holds
 * it now reads a different store — these objects have no owner left anywhere. They age out on their
 * own, much longer window ({@link MOVED_GRACE_ENV}), because a move is reversible by design and the
 * volume left behind is that promise; the window is where the promise ends.
 *
 * The placement answer is a SNAPSHOT, so a departure is re-confirmed immediately before the
 * destructive pass rather than trusted from the top of the run, and the timestamp has to MATCH: an
 * agent that returned and left again reads as departed both times, and the second departure has
 * served none of its window.
 *
 * One round trip is left between that read and the delete. A return inside it is meant to be refused
 * by the UID/resourceVersion precondition every delete carries — which is why a member taking an
 * agent over marks every claim of it, the suspended ones adoption skips included — but that mark is
 * EVENTUAL, not ordered with the placement commit (the CP commits the columns, recomputes duties
 * after, and grant → adopt → mark run asynchronously after that). So the gap is real and accepted
 * deliberately: closing it needs a fence the control plane invalidates in the same transaction as
 * the placement write, which is a CP design change and not taken here. It costs something only when
 * an agent a week gone returns inside that round trip, before any member reaches its claims, on an
 * install that has turned collection on — and then it costs the pool-local workspace state that
 * volume holds, which a return would otherwise have resumed onto and which a hard-cutover move
 * never copied anywhere else. §4 records that, and the wider residual the generic store sweep
 * carries, which shares neither this window nor this re-ask.
 *
 * That window runs from the control plane's own record of WHEN the placement changed, which the
 * placement answer carries. Nothing this sweep can observe would do: a claim's admission stamp dates
 * its last USE, and for a pod suspended before the move that is long before the move, so it would
 * delete the volume of an agent moved five minutes ago; and a mark the sweep wrote itself could not
 * see a departure, return and second departure that all happened between two of its ten-minute runs,
 * so the second move would inherit the first's spent window. Only the writer of the change knows.
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
/** How long the objects of an agent that MOVED off this pool are kept. Its own knob, not the leak
 *  grace: a leak is a mistake to clean up in minutes, a move is a deliberate act whose left-behind
 *  volume is the promise that the work is still there to move back to. The default matches the
 *  install's default session retention, so the pods of a departed agent go when its sessions would
 *  have expired anyway. */
export const MOVED_GRACE_ENV = 'AC_MOVED_AGENT_GRACE_MS'
export const DEFAULT_MOVED_GRACE_MS = 7 * 24 * 3_600_000

/**
 * How often a member must re-stamp the claims it holds, for a sweep that waits `graceMs`.
 *
 * ONE safety window, read from one place: the sweep decides a claim is collectable once nothing has
 * touched it for `graceMs`, so a member using a claim has to touch it strictly more often than that.
 * A third of the window leaves two missed ticks of margin. Derived rather than fixed because the grace
 * is deployment-owned — a hardcoded cadence is silently wrong for every install that shortens it, and
 * a floor would be the same bug at a different number.
 */
export function stampRefreshMsFor(graceMs: number): number {
  return Math.max(1, Math.floor(graceMs / 3))
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrphanReconcilerSettings {
  graceMs: number
  /** The window for an object whose agent moved off this pool; see {@link MOVED_GRACE_ENV}. */
  movedGraceMs: number
  deleteEnabled: boolean
}

export function resolveOrphanReconcilerSettings(env: NodeJS.ProcessEnv = process.env): OrphanReconcilerSettings {
  const flag = env[ORPHAN_DELETE_ENV]?.trim().toLowerCase()
  return {
    graceMs: positiveMs(env, ORPHAN_GRACE_ENV, DEFAULT_ORPHAN_GRACE_MS),
    movedGraceMs: positiveMs(env, MOVED_GRACE_ENV, DEFAULT_MOVED_GRACE_MS),
    deleteEnabled: flag === '1' || flag === 'true'
  }
}

function positiveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is not a positive integer: ${raw}`)
  return value
}

/** One sweep's counters, also the shape of its summary log line. */
export interface OrphanSweepSummary {
  candidates: number
  orphaned: number
  deleted: number
  skippedLive: number
  skippedGrace: number
  failed: number
  /** Of `orphaned`, those collected because their agent moved off this pool rather than vanished. */
  moved: number
}

export interface OrphanReconcilerDeps {
  api: Pick<SandboxApi, 'listClaims' | 'deleteClaimIfCurrent' | 'listSandboxes' | 'deleteSandboxIfCurrent'>
  /** Which of these agents the control plane still knows; a throw fails the sweep. */
  liveAgents: (agentIds: string[]) => Promise<Set<string>>
  /** Of the live ones, those the control plane no longer places on THIS pool, each mapped to the
   *  epoch ms its placement last changed. Absent, or an empty answer from a control plane that
   *  cannot tell, leaves every live agent's objects alone. */
  movedAgents?: (agentIds: string[]) => Promise<Map<string, number>>
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
      failed: 0,
      moved: 0
    }
    // Probe agents are member-local and never known to the control plane, so they are not asked about.
    const askable = [
      ...new Set(candidates.filter((c) => c.kind !== 'probe-claim' && UUID.test(c.agentId)).map((c) => c.agentId))
    ]
    const live = askable.length > 0 ? await this.deps.liveAgents(askable) : new Set<string>()
    // Asked of the live ones only: a gone agent is already collectable on the shorter window.
    const moved = await this.movedAway([...live])
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
        // An agent the control plane moved off this pool: nothing here will ever serve this object
        // again, so it ages out — on the moved window, from the departure stamp this sweep writes.
        const departedAt = moved.get(candidate.agentId)
        if (departedAt !== undefined) {
          // The object's own age still applies — it must be at least as old as the window too — so a
          // claim minted after the move is not taken for one the move left behind.
          if (now - departedAt < settings.movedGraceMs || !pastWindow(candidate, now, settings.movedGraceMs)) {
            summary.skippedGrace += 1
            continue
          }
          summary.moved += 1
          orphans.push(candidate)
          continue
        }
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
      if (!pastWindow(candidate, now, settings.graceMs)) {
        summary.skippedGrace += 1
        continue
      }
      orphans.push(candidate)
    }
    // Re-ask about the ones a DEPARTURE condemned, as late as possible. The answer above was read
    // before the whole sweep's work, and a returning agent must not be deleted against a snapshot
    // that predates its return. This narrows that to one round trip; what lands inside it is the
    // version fence's to refuse, which is why a takeover marks the claims it did not adopt.
    const confirmed = await this.stillGone(orphans, moved)
    summary.moved -= orphans.length - confirmed.length
    summary.skippedLive += orphans.length - confirmed.length
    summary.orphaned = confirmed.length
    for (const orphan of confirmed) {
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
        `skipped-live=${summary.skippedLive} skipped-grace=${summary.skippedGrace} moved=${summary.moved} ` +
        `failed=${summary.failed}` +
        (settings.deleteEnabled ? '' : ' (dry run)')
    )
    return summary
  }

  /**
   * The orphans still worth deleting: everything a departure did not condemn, plus those whose agent
   * the control plane still places elsewhere on the SAME departure it was condemned on.
   *
   * The timestamp has to match, not merely be present. An agent that returned and left again reads
   * as departed both times, but the second departure is a new one and has served none of its window —
   * deleting it against the first one's expired window would give it no grace at all. A changed
   * timestamp is therefore a return, and the next run judges the new departure from the start.
   *
   * A read that fails keeps everything, which is the safe direction: an agent whose placement nobody
   * can confirm is not collected.
   */
  private async stillGone(orphans: Candidate[], moved: Map<string, number>): Promise<Candidate[]> {
    const departed = [...new Set(orphans.map((o) => o.agentId).filter((id) => moved.has(id)))]
    if (departed.length === 0) return orphans
    const still = await this.movedAway(departed)
    const condemned = new Set(departed.filter((id) => still.get(id) === moved.get(id)))
    for (const id of departed) {
      if (condemned.has(id)) continue
      this.deps.log.info(
        still.has(id)
          ? `k8s orphans: agent ${id} left this pool again since this sweep read it — its new window starts fresh`
          : `k8s orphans: agent ${id} is this pool's again — leaving what it left behind`
      )
    }
    return orphans.filter((o) => !moved.has(o.agentId) || condemned.has(o.agentId))
  }

  // Fail-closed like every other read here: a control plane that cannot say where an agent is placed
  // leaves every live agent's objects exactly as the pre-placement sweep left them.
  private async movedAway(liveIds: string[]): Promise<Map<string, number>> {
    const ask = this.deps.movedAgents
    if (!ask || liveIds.length === 0) return new Map()
    try {
      return await ask(liveIds)
    } catch (err) {
      this.deps.log.warn(
        `k8s orphans: could not ask which agents left this pool — keeping every live agent's objects (${(err as Error).message})`
      )
      return new Map()
    }
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

/**
 * Is this object older than the window?
 *
 * The object's own age IS the grace: a one-shot run has no memory of an earlier sweep, and this is
 * the clock that matters anyway — no in-flight creation can still be racing the CP's write. Age runs
 * from the LATER of creation and the last time a member admitted or refreshed this claim, because one
 * in use — or one a returning session re-admitted — is young again, and only the stamp says so. An
 * age nobody can read never passes any window.
 */
function pastWindow(candidate: Candidate, now: number, windowMs: number): boolean {
  const since =
    candidate.admittedAt === undefined ? candidate.createdAt : Math.max(candidate.createdAt, candidate.admittedAt)
  return Number.isFinite(since) && now - since >= windowMs
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
