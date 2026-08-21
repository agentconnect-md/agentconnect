import { z } from 'zod'

/**
 * Sandbox keep-alive (C→D REQ → REP) — an open console page holding a cluster agent's pod against
 * the idle sweep, for exactly as long as there is work in it worth keeping.
 *
 * The sweep's clock is MESSAGE activity (`agentLastActivityTs`), which is the right rule for a
 * conversation and the wrong one for a page: a session whose worktree holds uncommitted edits, or
 * whose pull request is armed to merge when ready, has live state in the pod that a suspend throws
 * away — the edits go with the volume's process, and the in-pod merge watcher dies with it.
 *
 * A LEASE, not a flag: the console renews it on a timer while its document is visible, and the hold
 * lapses on its own within one TTL when the page closes, the tab goes to the background, or the
 * laptop sleeps. There is nothing to unset and nothing persisted — closing the page IS the release,
 * which is what keeps a forgotten tab from pinning a pod forever.
 *
 * The daemon decides whether to hold, from facts only it has: it never takes the console's word for
 * "dirty" or "armed". A request for an agent whose pod is already asleep holds nothing and wakes
 * nothing — resurrecting a suspended sandbox from a keep-alive poll would be the opposite of the
 * cost rule this serves.
 */

/** C→D REQ: renew the hold on this agent's sandbox, if the daemon finds a reason to. */
export const SandboxKeepAliveReq = z.object({
  agentId: z.string().min(1), // local agent id (NOT a wire UUID)
  /** The session whose worktree the uncommitted-file test reads; absent ⇒ the agent's primary tree.
   *  Required for a session-isolated workspace, where "dirty" is a per-worktree fact. */
  sessionId: z.string().min(1).optional()
})
export type SandboxKeepAliveReq = z.infer<typeof SandboxKeepAliveReq>

/** Why a sandbox is being held. Both are states the console can act on, so it can say which one. */
export const SandboxHoldReason = z.enum([
  'uncommitted-files', // the session's worktree has changes nobody has committed
  'auto-merge-armed' // a merge-when-ready watcher is armed here, and a suspend would kill it
])
export type SandboxHoldReason = z.infer<typeof SandboxHoldReason>

/**
 * D→C REP (corr = the req id) — whether the sandbox is held now, and why.
 *
 * `held:false` with no reasons is the ordinary answer for a clean tree and no armed merge: nothing
 * worth paying for, so the sweep may suspend on its own schedule. `placement:'daemon'` means the
 * agent runs no sandbox at all, and `asleep:true` that its pod is already suspended — both are
 * answers, not failures, and the console draws neither as an error.
 */
export const SandboxKeepAlive = z.object({
  agentId: z.string(),
  held: z.boolean(),
  reasons: z.array(SandboxHoldReason),
  /** How long this renewal holds for, so the console can pick a cadence inside it. */
  ttlMs: z.number().int().positive().optional(),
  placement: z.enum(['sandbox', 'daemon']).optional(),
  asleep: z.boolean().optional()
})
export type SandboxKeepAlive = z.infer<typeof SandboxKeepAlive>
