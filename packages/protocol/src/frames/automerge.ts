import { z } from 'zod'

/**
 * Merge-when-ready (C→D REQ → REP) — the PR panel's auto-merge toggle, served at the EDGE.
 *
 * GitHub's own `enablePullRequestAutoMerge` cannot back this control: it refuses any pull
 * request that is not BLOCKED, so on a repository without required status checks — the common
 * case — arming is impossible in every state (`clean status` / `unstable status`). The watcher
 * is therefore ours, and it lives where the agent runs: in the agent's sandbox for a
 * cluster-placed agent, in the owning daemon's process for a local one.
 *
 * Nothing is persisted anywhere. The armed set is IN-MEMORY at the edge, so a reclaimed
 * sandbox or a restarted daemon simply forgets — the box reads back unchecked, which is the
 * honest projection of "nobody is watching this pull request any more". The CP stores none of
 * it and runs no loop; it relays these two frames for the console and forgets them too
 * (body-locality — webchat-side-panels.md §2).
 */

/** Machine-readable `reason` on an auto-merge `BAD_PAYLOAD` error frame's `details`, so the CP
 *  answers with a code the console can branch on instead of the 503 that reads as an offline
 *  daemon. Everything else — waiting, refused by GitHub, no watcher — is DATA. */
export const AutoMergeErrorReason = z.enum([
  'unknown-agent', // no such agent on this daemon
  'unsupported-image', // a cluster agent whose runtime image ships no in-sandbox watcher
  /** A cluster agent whose sandbox is not up. Its watcher belongs IN that pod, so there is nowhere to
   *  arm one until the sandbox is started — the console's own wake action is the fix, and answering
   *  this beats arming a loop somewhere the operator's next read would not find it. */
  'sandbox-asleep',
  /** The PR is mergeable RIGHT NOW, so arming would merge it on the first tick with no confirmation.
   *  The direct Merge button is the surface for that, and it deliberately takes two presses. */
  'already-mergeable'
])
export type AutoMergeErrorReason = z.infer<typeof AutoMergeErrorReason>

/** Display ceiling for the watcher's own status line. Composed from GitHub's answer (check
 *  names, refusal messages), so it is bounded on the wire rather than trusted. */
export const MAX_AUTO_MERGE_DETAIL = 300

/** The pull request a watcher is addressed by. Not a session: the watcher outlives any one
 *  turn, and two sessions on one agent's shared checkout can name the same pull request. */
export const AutoMergeTarget = z.object({
  agentId: z.string().min(1), // the agent id the CP addresses this daemon's agents by, as `agent/wake` does
  repoFullName: z.string().min(3).max(200), // "owner/repo"
  prNumber: z.number().int().positive()
})
export type AutoMergeTarget = z.infer<typeof AutoMergeTarget>

/** C→D REQ: arm or disarm the watcher. Idempotent — asking for the state it is already in
 *  answers with that state and starts nothing. */
export const AutoMergeSetReq = AutoMergeTarget.extend({ enabled: z.boolean() })
export type AutoMergeSetReq = z.infer<typeof AutoMergeSetReq>

/** C→D REQ: what the edge currently holds for this pull request. */
export const AutoMergeStateReq = AutoMergeTarget
export type AutoMergeStateReq = z.infer<typeof AutoMergeStateReq>

/**
 * D→C REP (corr = the req id) — the watcher's whole observable state.
 *
 * `placement` says WHERE the loop runs, because the two have different lifetimes and the
 * console says so: `sandbox` dies with the pod, `daemon` with the daemon process.
 *
 * `waitingOn` is the watcher's own last verdict ("checks: build, lint", "changes requested",
 * "conflicts with main") — the answer to "why has this not merged yet", which GitHub's auto-
 * merge never gave us. `lastError` is a refusal from GitHub or an unreachable one; the armed
 * state SURVIVES it, because the fix is usually the next commit and disarming on the first red
 * check would throw away the intent the operator expressed.
 */
export const AutoMergeState = z.object({
  agentId: z.string(),
  repoFullName: z.string(),
  prNumber: z.number().int().positive(),
  armed: z.boolean(),
  placement: z.enum(['sandbox', 'daemon']).optional(), // absent ⇒ nothing armed, so nowhere
  waitingOn: z.string().max(MAX_AUTO_MERGE_DETAIL).optional(),
  lastError: z.string().max(MAX_AUTO_MERGE_DETAIL).optional(),
  /** The watcher merged it. A terminal answer: the entry is gone and `armed` is false. */
  merged: z.boolean().optional()
})
export type AutoMergeState = z.infer<typeof AutoMergeState>
