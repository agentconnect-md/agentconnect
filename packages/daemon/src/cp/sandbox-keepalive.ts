import type { SandboxHoldReason, SandboxKeepAlive, SandboxKeepAliveReq } from '@agentconnect.md/protocol'
import { AGENT_WIDE_HOLDER, type SandboxHolds } from '../k8s/sandbox-hold.js'

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
 *
 * The lease is taken per SESSION, because the dirty-tree fact is: two console pages on one agent read
 * two different worktrees, and an agent-wide lease let the page polling a clean session release the
 * one a page watching a dirty session was keeping alive.
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
    // This page's own lease. A poll that names no session speaks for the agent, not for a worktree.
    const holder = req.sessionId ?? AGENT_WIDE_HOLDER
    if (!deps.knownAgent(agentId)) return { agentId, held: false, reasons: [] }
    if (!deps.runsInSandbox(agentId)) {
      // An asleep pod invalidates EVERY page's lease, not just this one's: the volume it held is gone.
      deps.holds.releaseAll(agentId)
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
      // own schedule, not a TTL later because of a hold the previous poll took. Only THIS page's
      // lease goes — another session's dirty worktree is still a reason to keep the pod.
      deps.holds.release(agentId, holder)
      // `held:false` is this page's answer about its own session, so it is reported even while a
      // sibling page holds the pod: what it must not do is claim a lease it did not take.
      return { agentId, held: false, reasons: [], placement: 'sandbox' }
    }
    return {
      agentId,
      held: true,
      reasons,
      ttlMs: deps.holds.renew(agentId, holder, reasons),
      placement: 'sandbox'
    }
  }
}
