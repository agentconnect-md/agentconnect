import type { SandboxHoldReason, SandboxKeepAlive, SandboxKeepAliveReq } from '@agentconnect.md/protocol'
import { AGENT_WIDE_HOLDER, type SandboxHolds } from '../k8s/sandbox-hold.js'

// The keep-alive decision (k8s-daemon-pool §4): the daemon reads an open page's facts itself — a dirty worktree, an armed watcher the sweep also holds for on its own — and leases each pod a fact is ABOUT, per session holder, never waking one.
export interface SandboxKeepAliveDepsInternal {
  /** The pod this page's session lives on, off its own directory as its wake and reads route it — never the agent's for an isolated session, whatever its primary is; the agent's with no session. */
  podFor: (agentId: string, sessionId?: string) => Promise<string>
  /** The agent's own pod — where an armed merge watcher runs, whatever worktree this page is watching. */
  agentPod: (agentId: string) => string
  /** Hold one pod against the idle sweep while it is bound, or undefined when it is asleep or was never placed there. */
  holdIfBound: (subject: string) => (() => void) | undefined
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
    const agentPod = deps.agentPod(agentId)
    // A routing this daemon cannot answer names the agent's own pod, which is where an unrouted path lives anyway.
    const pod = await deps.podFor(agentId, req.sessionId).catch(() => agentPod)
    // Each reason holds the pod it is ABOUT — one entry when this page's worktree is on the agent's own pod.
    const byPod = new Map<string, SandboxHoldReason[]>([
      [agentPod, []],
      [pod, []]
    ])
    // One pod's read, under a hold taken ACROSS it rather than a check made before it: a sweep landing
    // in between would otherwise leave the routed runner waking the pod to answer. Reports bound-ness.
    const onPod = async (subject: string, read: () => Promise<void>): Promise<boolean> => {
      const release = deps.holdIfBound(subject)
      if (!release) {
        // An asleep pod invalidates EVERY page's lease ON IT, not just this one's: the volume they were taken on is gone.
        deps.holds.releaseAll(subject)
        return false
      }
      try {
        await read()
      } finally {
        release()
      }
      return true
    }
    // A registry read that fails is not evidence of an armed watcher, so it costs this reason only.
    const readWatcher = async (): Promise<void> => {
      if (await deps.armedFor(agentId).catch(() => false)) byPod.get(agentPod)!.push('auto-merge-armed')
    }
    const readTree = async (): Promise<void> => {
      try {
        const status = await deps.gitStatus(agentId, req.sessionId)
        // `isRepo:false` is a workspace with no checkout — nothing to be dirty about, not a failure.
        if (status.isRepo !== false && status.clean === false) byPod.get(pod)!.push('uncommitted-files')
      } catch (err) {
        deps.log?.debug?.(`keepalive: git status for "${agentId}" failed: ${(err as Error)?.message}`)
      }
    }
    // Judged INDEPENDENTLY, one pod each, so a sleeping session pod is not read while the agent's still reports its watcher; one pod when they are the same.
    let bound: boolean
    if (pod === agentPod) {
      bound = await onPod(pod, async () => {
        await readWatcher()
        await readTree()
      })
    } else {
      await onPod(agentPod, readWatcher)
      bound = await onPod(pod, readTree)
    }
    let ttlMs: number | undefined
    for (const [subject, held] of byPod) {
      // RELEASE rather than lapse: a tree that just went clean should be suspendable on the sweep's
      // own schedule, not a TTL later because of a hold the previous poll took. Only THIS page's
      // lease goes — another session's dirty worktree is still a reason to keep its pod.
      if (held.length === 0) deps.holds.release(subject, holder)
      else ttlMs = deps.holds.renew(subject, holder, held)
    }
    // `asleep` is this page's answer about the pod its OWN worktree lives on, whatever it still holds elsewhere.
    const sleeping = bound ? {} : { asleep: true }
    const reasons = [...new Set([...byPod.values()].flat())]
    // `held:false` is this page's answer about its own session, so it is reported even while a
    // sibling page holds the pod: what it must not do is claim a lease it did not take.
    if (reasons.length === 0) return { agentId, held: false, reasons: [], placement: 'sandbox', ...sleeping }
    return {
      agentId,
      held: true,
      reasons,
      ...(ttlMs === undefined ? {} : { ttlMs }),
      placement: 'sandbox',
      ...sleeping
    }
  }
}
