/**
 * The decision half of GitHub admission into the per-sessionKey serial gate
 * (webhook-triggers-and-github-events.md): which relay-fired revision of one PR
 * lane wins, which queued or active turns it supersedes, which review-thread
 * deliveries coalesce into a single batched review, and when an open batch is
 * ready to seal. Every function here is pure — it reads explicit queue
 * snapshots and clock values and returns a plan. The Daemon keeps the appliers
 * that mutate `serialQueue`/`activeGateEntries`, settle sinks, and write the
 * durable inbox, because their ordering is production-visible.
 */
import {
  compareGithubPullRevisionRecency,
  githubHookCoordinates,
  githubPullRequestLane,
  githubPullRevisionStream,
  githubReviewBatchStream,
  renderGithubReviewBatchPrompt,
  GITHUB_REVIEW_BATCH_MAX_COMMENTS,
  GITHUB_REVIEW_BATCH_MAX_WAIT_MS,
  GITHUB_REVIEW_BATCH_QUIET_MS,
  type GithubQueueCandidate,
  type GithubRevisionAdmissionPlan,
  type GithubReviewBatch,
  type HookDispatchContext
} from './hook-coords.js'
import type { QueueEntry } from '../daemon/turn-types.js'

/** Flatten the gate's live heads plus every queued entry into one candidate list. */
export function collectGithubQueueCandidates(
  activeGateEntries: ReadonlyMap<string, QueueEntry>,
  serialQueue: ReadonlyMap<string, QueueEntry[]>
): GithubQueueCandidate[] {
  const candidates: GithubQueueCandidate[] = []
  for (const [key, entry] of activeGateEntries) candidates.push({ key, entry, state: 'active' })
  for (const [key, queue] of serialQueue) {
    for (const entry of queue) candidates.push({ key, entry, state: 'queued' })
  }
  return candidates
}

/** Pick the newest relay-fired revision across every session key in one trusted GitHub lane. */
export function planGithubRevisionAdmission(
  key: string,
  incoming: QueueEntry,
  candidates: readonly GithubQueueCandidate[]
): GithubRevisionAdmissionPlan | undefined {
  const stream = githubPullRevisionStream(
    incoming.hookContext,
    githubHookCoordinates(incoming.agentId, incoming.msg, incoming.integrationId)
  )
  if (!stream) return undefined
  const revisions = [
    ...candidates.filter(
      (candidate) =>
        !candidate.entry.cancelledReason &&
        githubPullRevisionStream(
          candidate.entry.hookContext,
          githubHookCoordinates(candidate.entry.agentId, candidate.entry.msg, candidate.entry.integrationId)
        ) === stream
    ),
    { key, entry: incoming, state: 'incoming' as const }
  ]
  const winner = revisions.reduce((latest, candidate) =>
    compareGithubPullRevisionRecency(candidate.entry.hookContext!, latest.entry.hookContext!) > 0 ? candidate : latest
  )
  return {
    winner,
    superseded: revisions.filter((candidate) => candidate !== winner)
  }
}

/** Per-key replacement queues once the superseded queued entries are dropped; `undefined` means delete the key. */
export function planQueuedGithubRevisionRemovals(
  candidates: readonly GithubQueueCandidate[],
  serialQueue: ReadonlyMap<string, QueueEntry[]>
): Map<string, QueueEntry[] | undefined> {
  const removals = new Map<string, Set<QueueEntry>>()
  for (const candidate of candidates) {
    if (candidate.state !== 'queued') continue
    const entries = removals.get(candidate.key) ?? new Set<QueueEntry>()
    entries.add(candidate.entry)
    removals.set(candidate.key, entries)
  }
  const next = new Map<string, QueueEntry[] | undefined>()
  for (const [key, entries] of removals) {
    const kept = (serialQueue.get(key) ?? []).filter((entry) => !entries.has(entry))
    next.set(key, kept.length > 0 ? kept : undefined)
  }
  return next
}

/** Fold new waits into an entry's existing coordination wait; `undefined` means leave it untouched. */
export function combineCoordinationWaits(
  existing: Promise<void> | undefined,
  waits: readonly Promise<void>[]
): Promise<void> | undefined {
  const pending = [...(existing ? [existing] : []), ...waits]
  if (pending.length === 0) return undefined
  return Promise.all(pending).then(() => undefined)
}

export interface GithubRevisionAdmissionEffects {
  /** Queued or incoming losers: removed from the queue and settled outright. */
  terminalLosers: GithubQueueCandidate[]
  /** Losers already generating: their completion is awaited by the winner. */
  activeLosers: GithubQueueCandidate[]
  /** Active losers reviewing a different head: only a genuinely newer revision preempts running work. */
  preemptableActiveLosers: GithubQueueCandidate[]
  /** Lane the winner belongs to, so its own re-admission survives the interrupt. */
  winnerLane: string | undefined
  /** The winner is not yet running, so it must absorb the losers' teardown waits. */
  winnerNeedsWait: boolean
  /** The caller's own entry won and may proceed. */
  incomingWins: boolean
}

export function planGithubRevisionAdmissionEffects(
  plan: GithubRevisionAdmissionPlan,
  incoming: QueueEntry
): GithubRevisionAdmissionEffects {
  const winnerHead = plan.winner.entry.hookContext?.github?.headSha
  const activeLosers = plan.superseded.filter((candidate) => candidate.state === 'active')
  return {
    terminalLosers: plan.superseded.filter((candidate) => candidate.state !== 'active'),
    activeLosers,
    preemptableActiveLosers: activeLosers.filter(
      (candidate) => candidate.entry.hookContext?.github?.headSha !== winnerHead
    ),
    winnerLane: githubPullRequestLane(
      plan.winner.entry.hookContext,
      githubHookCoordinates(plan.winner.entry.agentId, plan.winner.entry.msg, plan.winner.entry.integrationId)
    ),
    winnerNeedsWait: plan.winner.state !== 'active',
    incomingWins: plan.winner.entry === incoming
  }
}

/** Oldest open, unsealed, non-full batch on the incoming delivery's review stream. */
export function selectGithubReviewBatchLeader(
  incoming: QueueEntry,
  candidates: readonly GithubQueueCandidate[]
): QueueEntry | undefined {
  const batchStream = githubReviewBatchStream(
    incoming.hookContext,
    githubHookCoordinates(incoming.agentId, incoming.msg, incoming.integrationId)
  )
  if (!batchStream) return undefined
  return candidates
    .map((candidate) => candidate.entry)
    .filter((candidate) => {
      const batch = candidate.hookContext?.githubReviewBatch
      return (
        !candidate.cancelledReason &&
        githubReviewBatchStream(
          candidate.hookContext,
          githubHookCoordinates(candidate.agentId, candidate.msg, candidate.integrationId)
        ) === batchStream &&
        batch !== undefined &&
        !batch.sealed &&
        batch.items.length < GITHUB_REVIEW_BATCH_MAX_COMMENTS
      )
    })
    .sort((a, b) => compareGithubPullRevisionRecency(a.hookContext!, b.hookContext!))[0]
}

export interface GithubReviewBatchCoalescePlan {
  /** Leader hook context carrying the follower's thread appended to the batch. */
  nextHook: HookDispatchContext
  /** Review-thread root comment id folded in, for the operator log line. */
  threadRootCommentId: string
  reviewId: string
}

/** Decide whether a follower review-thread delivery folds into the leader's open batch. */
export function planGithubReviewBatchCoalesce(
  leader: QueueEntry,
  follower: QueueEntry,
  now: number
): GithubReviewBatchCoalescePlan | undefined {
  const leaderHook = leader.hookContext
  const followerHook = follower.hookContext
  const leaderBatch = leaderHook?.githubReviewBatch
  const followerItem = followerHook?.githubReviewBatch?.items[0]
  if (!leaderHook || !followerHook || !leaderBatch || !followerItem || !leader.inboxId || !follower.inboxId) {
    return undefined
  }
  if (
    leaderBatch.sealed ||
    leaderBatch.items.length >= GITHUB_REVIEW_BATCH_MAX_COMMENTS ||
    leaderBatch.items.some(
      (item) => item.reply.reviewThreadRootCommentId === followerItem.reply.reviewThreadRootCommentId
    )
  ) {
    return undefined
  }
  return {
    nextHook: {
      ...leaderHook,
      githubReviewBatch: { ...leaderBatch, updatedAt: now, items: [...leaderBatch.items, followerItem] }
    },
    threadRootCommentId: followerItem.reply.reviewThreadRootCommentId,
    reviewId: leaderBatch.reviewId
  }
}

export type GithubReviewBatchStep =
  /** Nothing left to settle; `clearReply` drops the single-thread reply target of an already sealed batch. */
  | { action: 'stop'; clearReply: boolean }
  | { action: 'wait'; delayMs: number }
  /** Quiet or max-wait window elapsed; `promptText` is set only for a genuinely multi-thread batch. */
  | { action: 'seal'; sealed: GithubReviewBatch; promptText?: string }

/** One turn of the batch settle loop: stop, sleep until the next deadline, or seal. */
export function githubReviewBatchSettleStep(
  batch: GithubReviewBatch | undefined,
  cancelled: boolean,
  now: number
): GithubReviewBatchStep {
  if (!batch) return { action: 'stop', clearReply: false }
  if (batch.sealed) return { action: 'stop', clearReply: batch.items.length > 1 }
  if (cancelled) return { action: 'stop', clearReply: false }
  const deadline = Math.min(
    batch.updatedAt + GITHUB_REVIEW_BATCH_QUIET_MS,
    batch.openedAt + GITHUB_REVIEW_BATCH_MAX_WAIT_MS
  )
  const delayMs = deadline - now
  if (delayMs > 0) return { action: 'wait', delayMs }
  const sealed: GithubReviewBatch = { ...batch, sealed: true }
  return {
    action: 'seal',
    sealed,
    ...(sealed.items.length > 1 ? { promptText: renderGithubReviewBatchPrompt(sealed) } : {})
  }
}
