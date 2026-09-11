import { systemClock, type Clock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { AC_LABEL_AGENT, AC_LABEL_SESSION } from './sandbox-identity.js'
import { probeClaimExpiry } from './probe-claim.js'
import type { OperatingMode, Sandbox, SandboxApi, SandboxClaim } from './sandbox-api.js'

/**
 * The pool's idle-volume reaper: the sweep that gives back an AGENT pod's workspace volume after
 * nobody has used the agent for a window, instead of holding one PVC per agent for as long as the
 * agent row exists (k8s-daemon-pool.md §4).
 *
 * It exists because suspension reclaims compute and nothing reclaimed storage. A suspended agent
 * sandbox costs no CPU and no memory, but its claim keeps a provisioned volume, and the only path
 * that ever deleted an agent claim was agent removal (`discardAgent`). Session pods already have a
 * reclamation path — the retention GC deletes a session's row and its claim together — so an
 * install accumulated exactly one leaked-looking-but-not-leaked volume per agent anyone had ever
 * used. The orphan reconciler cannot collect those: their agents are alive, which is precisely the
 * case it refuses to touch.
 *
 * Rides the reconciler CronJob, and is a second sweep rather than a second job because it needs no
 * scheduler, no lease and no control-plane read of its own — the cluster already owns the cadence
 * and `concurrencyPolicy: Forbid`, and this sweep asks only Kubernetes and the shared store.
 *
 * Safety over completeness, like the orphan sweep, and for the same reason: deleting a claim
 * deletes the workspace volume and there is no undo. A candidate is collected only when all four
 * hold — it is an agent pod's claim, its Sandbox is `Suspended`, its agent has NO session row left
 * in the shared store, and the claim itself is older than the window. The third is the load-bearing
 * one: a session row's existence is what keeps a session pod's claim (git-workspace-model.md §11),
 * and the retention GC deletes a row only after judging that session's worktrees — including
 * REFUSING to delete one that still holds uncommitted or unpushed work. So "this agent has no
 * session rows" reads as "session retention has already judged and released every session of this
 * agent", which is the fact that makes its volume disposable. The agent's own checkout is not
 * judged — the pod is suspended and judging would mean waking it — so the window is what stands in
 * for that: an agent nobody has touched for a week has a re-clonable checkout, not a workspace.
 *
 * Two consequences worth naming. An install with `sessions.retention: never` collects no agent
 * volume at all, which is correct rather than broken: keeping every session forever is keeping
 * their workspaces. And the effective idle time is `max(sessions.retention, this window)`, because
 * a session row survives its own window before this sweep can see an agent as row-free.
 *
 * Deliberately NOT fenced on `agentconnect.md/last-admitted-at`, unlike the orphan sweep. That stamp
 * means "last seen in use by a member", and a rollout re-stamps every claim it adopts — a window of
 * days measured from it would be reset by every deploy and would never elapse. What it still does
 * here is fence the delete: a wake writes it, which moves the claim's resourceVersion and makes the
 * preconditioned delete below fail rather than take a volume a member just woke.
 *
 * Ships dry-run, like the orphan sweep: it logs and counts until the deployment enables deletion.
 */

/** Deployment-owned settings, env like the rest of the plane's; absent ⇒ the default below. */
export const IDLE_VOLUME_WINDOW_ENV = 'AC_K8S_IDLE_VOLUME_MS'
/** Deletion is opt-in: `1`/`true` collects, anything else only reports. */
export const IDLE_VOLUME_DELETE_ENV = 'AC_K8S_IDLE_VOLUME_DELETE'
export const DEFAULT_IDLE_VOLUME_MS = 7 * 24 * 60 * 60_000

export interface IdleVolumeReaperSettings {
  windowMs: number
  deleteEnabled: boolean
}

export function resolveIdleVolumeReaperSettings(env: NodeJS.ProcessEnv = process.env): IdleVolumeReaperSettings {
  const raw = env[IDLE_VOLUME_WINDOW_ENV]?.trim()
  let windowMs = DEFAULT_IDLE_VOLUME_MS
  if (raw) {
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`${IDLE_VOLUME_WINDOW_ENV} is not a positive integer: ${raw}`)
    windowMs = value
  }
  const flag = env[IDLE_VOLUME_DELETE_ENV]?.trim().toLowerCase()
  return { windowMs, deleteEnabled: flag === '1' || flag === 'true' }
}

/** One sweep's counters, also the shape of its summary log line. */
export interface IdleVolumeSweepSummary {
  candidates: number
  idle: number
  deleted: number
  skippedRecent: number
  skippedAwake: number
  skippedSessions: number
  failed: number
}

export interface IdleVolumeReaperDeps {
  api: Pick<SandboxApi, 'listClaims' | 'listSandboxes' | 'deleteClaimIfCurrent'>
  /** Which of these agents still have ANY session row; absent or throwing ⇒ every agent reads as in use. */
  agentsWithSessions?: (agentIds: string[]) => Promise<Set<string>>
  settings: IdleVolumeReaperSettings
  clock?: Clock
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/** A collectable agent volume: whose it is, and how to delete exactly the claim that holds it. */
interface Candidate {
  name: string
  uid: string
  resourceVersion?: string
  agentId: string
  /** The Sandbox the claim is bound to, absent while the claim is unbound. */
  sandboxName?: string
  /** Epoch ms, NaN when the object did not say — an age nobody knows never passes the window. */
  createdAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class IdleVolumeReaper {
  private readonly clock: Clock

  constructor(private readonly deps: IdleVolumeReaperDeps) {
    this.clock = deps.clock ?? systemClock
  }

  /** One sweep. Resolves undefined when it failed — the CronJob turns that into a non-zero exit. */
  async sweep(): Promise<IdleVolumeSweepSummary | undefined> {
    try {
      return await this.runSweep()
    } catch (err) {
      this.deps.log.warn(`k8s idle volumes: sweep failed — ${(err as Error).message}`)
      return undefined
    }
  }

  private async runSweep(): Promise<IdleVolumeSweepSummary> {
    const { settings, log } = this.deps
    const now = this.clock.now()
    const claims = await this.deps.api.listClaims()
    const candidates: Candidate[] = []
    // A session pod of the same agent is judged by the retention GC, never here — but its presence
    // also says the agent's sessions are not all gone, so it vetoes the agent's own claim.
    const withSessionPods = new Set<string>()
    for (const claim of claims) {
      const labels = claim.spec?.additionalPodMetadata?.labels
      const agentId = labels?.[AC_LABEL_AGENT]
      if (!agentId) continue
      if (labels[AC_LABEL_SESSION]) {
        withSessionPods.add(agentId)
        continue
      }
      // A probe claim is member-local and has its own window; the orphan sweep owns it.
      if (probeClaimExpiry(claim) !== undefined) continue
      if (!UUID.test(agentId)) continue
      const candidate = candidateOf(claim, agentId)
      if (candidate) candidates.push(candidate)
    }
    const summary: IdleVolumeSweepSummary = {
      candidates: candidates.length,
      idle: 0,
      deleted: 0,
      skippedRecent: 0,
      skippedAwake: 0,
      skippedSessions: 0,
      failed: 0
    }
    // Age first: it costs nothing, and it is what keeps a freshly prepared volume — an agent whose
    // sessions were all collected and which has since been re-claimed — out of the store read.
    const aged = candidates.filter((candidate) => {
      if (Number.isFinite(candidate.createdAt) && now - candidate.createdAt >= settings.windowMs) return true
      summary.skippedRecent += 1
      return false
    })
    // Only a Suspended pod is collectable: one a member has awake is in use, whatever the rows say.
    const modes = aged.length > 0 ? await this.operatingModes() : new Map<string, OperatingMode | undefined>()
    const asleep = aged.filter((candidate) => {
      if (candidate.sandboxName !== undefined && modes.get(candidate.sandboxName) === 'Suspended') return true
      summary.skippedAwake += 1
      return false
    })
    const inUse = await this.agentsWithSessions(asleep.map((candidate) => candidate.agentId))
    const idle: Candidate[] = []
    for (const candidate of asleep) {
      if (inUse === undefined || inUse.has(candidate.agentId) || withSessionPods.has(candidate.agentId)) {
        summary.skippedSessions += 1
        continue
      }
      idle.push(candidate)
    }
    summary.idle = idle.length
    for (const candidate of idle) {
      if (!settings.deleteEnabled) {
        log.info(
          `k8s idle volumes: would delete claim ${candidate.name} (agent ${candidate.agentId}) — ` +
            `idle for ${Math.floor((now - candidate.createdAt) / 86_400_000)}d, dry run`
        )
        continue
      }
      try {
        const current = await this.deps.api.deleteClaimIfCurrent(candidate.name, {
          uid: candidate.uid,
          ...(candidate.resourceVersion ? { resourceVersion: candidate.resourceVersion } : {})
        })
        if (current) {
          summary.deleted += 1
          log.info(`k8s idle volumes: deleted claim ${candidate.name} (agent ${candidate.agentId}) with its volume`)
        } else {
          log.info(`k8s idle volumes: claim ${candidate.name} was used since it was listed — left alone`)
        }
      } catch (err) {
        summary.failed += 1
        log.warn(`k8s idle volumes: deleting claim ${candidate.name} failed — ${(err as Error).message}`)
      }
    }
    log.info(
      `k8s idle volumes: swept ${summary.candidates} agent volumes — idle=${summary.idle} deleted=${summary.deleted} ` +
        `skipped-recent=${summary.skippedRecent} skipped-awake=${summary.skippedAwake} ` +
        `skipped-sessions=${summary.skippedSessions} failed=${summary.failed}` +
        (settings.deleteEnabled ? '' : ' (dry run)')
    )
    return summary
  }

  // Fail-closed: no store to ask, or a store that will not answer, keeps every agent's volume.
  private async agentsWithSessions(agentIds: string[]): Promise<Set<string> | undefined> {
    if (agentIds.length === 0) return new Set()
    const ask = this.deps.agentsWithSessions
    if (!ask) return undefined
    try {
      return await ask([...new Set(agentIds)])
    } catch (err) {
      this.deps.log.warn(
        `k8s idle volumes: could not ask which agents still have sessions — keeping every volume (${(err as Error).message})`
      )
      return undefined
    }
  }

  // Sandbox name → operating mode. A Role without `list` on Sandboxes leaves every mode unknown,
  // which reads as awake and collects nothing: the suspension proof is not optional here.
  private async operatingModes(): Promise<Map<string, OperatingMode | undefined>> {
    let sandboxes: Sandbox[]
    try {
      sandboxes = await this.deps.api.listSandboxes()
    } catch (err) {
      if (!(err instanceof K8sApiError) || err.status !== 403) throw err
      this.deps.log.warn(`k8s idle volumes: listing sandboxes is not permitted — no volume can be proven idle`)
      return new Map()
    }
    const modes = new Map<string, OperatingMode | undefined>()
    for (const sandbox of sandboxes) {
      const name = sandbox.metadata?.name
      if (name) modes.set(name, sandbox.spec?.operatingMode)
    }
    return modes
  }
}

/** The claim's own coordinates, or undefined when it cannot name itself. */
function candidateOf(claim: SandboxClaim, agentId: string): Candidate | undefined {
  const name = claim.metadata?.name
  const uid = claim.metadata?.uid
  if (!name || !uid) return undefined
  const resourceVersion = claim.metadata?.resourceVersion
  const sandboxName = claim.status?.sandbox?.name
  return {
    name,
    uid,
    ...(resourceVersion ? { resourceVersion } : {}),
    agentId,
    ...(sandboxName ? { sandboxName } : {}),
    createdAt: Date.parse(claim.metadata?.creationTimestamp ?? '')
  }
}
