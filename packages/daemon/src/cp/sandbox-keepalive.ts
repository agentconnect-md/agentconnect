import type { SandboxHoldReason, SandboxKeepAlive, SandboxKeepAliveReq } from '@agentconnect.md/protocol'
import type { SandboxHolds } from '../k8s/sandbox-hold.js'

/**
 * The keep-alive decision: does an open console page's agent hold work a pod suspend would throw
 * away, and if so, renew the lease (`k8s/sandbox-hold.ts`).
 *
 * The daemon reads both facts itself and never takes the console's word for them, because the answer
 * authorizes cost — a caller that could assert "dirty" could pin a pod indefinitely. Assembled here
 * rather than on `Daemon` because the git seam is built with the rest of the CP deps, and the whole
 * decision is small enough to be worth having in one testable function.
 *
 * Two rules, both matching what the console is showing the operator:
 *  - uncommitted files in the session's own worktree — the edits live on the pod's volume;
 *  - an armed merge-when-ready watcher — for a cluster agent it is a process IN that pod, so
 *    suspending would silently disarm the box the operator ticked.
 *
 * A SUSPENDED pod holds nothing and is not woken. Resurrecting a sandbox from a keep-alive poll
 * would invert the rule this exists to serve, and there is nothing to read in a pod that is down.
 */
export interface SandboxKeepAliveDepsInternal {
  /** Whether this agent's work runs in a pod right now; false ⇒ asleep or never placed there. */
  runsInSandbox: (agentId: string) => boolean
  /** Whether this daemon holds the agent at all — an unknown id holds nothing. */
  knownAgent: (agentId: string) => boolean
  /** Whether ANY pull request is armed for this agent, wherever its watcher lives. */
  armedFor: (agentId: string) => Promise<boolean>
  /** The session worktree's git status, as the Git panel reads it. */
  gitStatus: (agentId: string, sessionId?: string) => Promise<{ isRepo?: boolean; clean?: boolean }>
  holds: SandboxHolds
  log?: { debug?: (message: string) => void }
}

export function createSandboxKeepAlive(
  deps: SandboxKeepAliveDepsInternal
): (req: SandboxKeepAliveReq) => Promise<SandboxKeepAlive> {
  return async (req) => {
    const agentId = req.agentId
    if (!deps.knownAgent(agentId)) return { agentId, held: false, reasons: [] }
    if (!deps.runsInSandbox(agentId)) {
      deps.holds.release(agentId)
      return { agentId, held: false, reasons: [], placement: 'sandbox', asleep: true }
    }
    const reasons: SandboxHoldReason[] = []
    // A registry read that fails is not evidence of an armed watcher, so it costs this reason only.
    if (await deps.armedFor(agentId).catch(() => false)) reasons.push('auto-merge-armed')
    try {
      const status = await deps.gitStatus(agentId, req.sessionId)
      // `isRepo:false` is a workspace with no checkout — nothing to be dirty about, not a failure.
      if (status.isRepo !== false && status.clean === false) reasons.push('uncommitted-files')
    } catch (err) {
      deps.log?.debug?.(`keepalive: git status for "${agentId}" failed: ${(err as Error)?.message}`)
    }
    if (reasons.length === 0) {
      // RELEASE rather than lapse: a tree that just went clean should be suspendable on the sweep's
      // own schedule, not a TTL later because of a hold the previous poll took.
      deps.holds.release(agentId)
      return { agentId, held: false, reasons: [], placement: 'sandbox' }
    }
    return { agentId, held: true, reasons, ttlMs: deps.holds.renew(agentId, reasons), placement: 'sandbox' }
  }
}
