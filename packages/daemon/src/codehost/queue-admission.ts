/**
 * The decision half of code-host admission into the per-sessionKey serial gate
 * (webhook-triggers-and-github-events.md, gitlab-com-integration.md §12.3): which
 * relay-fired revision of one change-request lane wins, which queued or active turns
 * it supersedes, which comment deliveries coalesce into a single batched reply, and
 * when an open batch is ready to seal. Every function here is pure — it reads explicit
 * queue snapshots and clock values and returns a plan, routing each provider question
 * through the hook-admission seam. The Daemon keeps the appliers that mutate
 * `serialQueue`/`activeGateEntries`, settle sinks, and write the durable inbox, because
 * their ordering is production-visible.
 */
import {
  batchNeedsOwnPrompt,
  compareHookDeliveryRecency,
  hookAdmissionFor,
  hookCoordinates,
  revisionStreamsContest,
  REVIEW_BATCH_MAX_COMMENTS,
  REVIEW_BATCH_MAX_WAIT_MS,
  REVIEW_BATCH_QUIET_MS,
  type CodeHostRevisionStream,
  type HookQueueCandidate,
  type RevisionAdmissionPlan
} from './hook-admission.js'
import type { GithubReviewBatch, HookDispatchContext } from '../github/hook-coords.js'
import type { QueueEntry } from '../daemon/turn-types.js'

/** Flatten the gate's live heads plus every queued entry into one candidate list. */
export function collectHookQueueCandidates(
  activeGateEntries: ReadonlyMap<string, QueueEntry>,
  serialQueue: ReadonlyMap<string, QueueEntry[]>
): HookQueueCandidate[] {
  const candidates: HookQueueCandidate[] = []
  for (const [key, entry] of activeGateEntries) candidates.push({ key, entry, state: 'active' })
  for (const [key, queue] of serialQueue) {
    for (const entry of queue) candidates.push({ key, entry, state: 'queued' })
  }
  return candidates
}

/** The generation stream one queue candidate belongs to, if any. */
function candidateRevisionStream(candidate: QueueEntry): CodeHostRevisionStream | undefined {
  const hook = candidate.hookContext
  return hookAdmissionFor(hook)?.revisionStream(
    hook,
    hookCoordinates(candidate.agentId, candidate.msg, candidate.integrationId)
  )
}

/** Pick the newest relay-fired revision across every session key in one trusted code-host lane. */
export function planRevisionAdmission(
  key: string,
  incoming: QueueEntry,
  candidates: readonly HookQueueCandidate[]
): RevisionAdmissionPlan | undefined {
  const stream = candidateRevisionStream(incoming)
  if (!stream) return undefined
  const revisions = [
    ...candidates.filter((candidate) => {
      if (candidate.entry.cancelledReason) return false
      const other = candidateRevisionStream(candidate.entry)
      return other !== undefined && revisionStreamsContest(stream, other)
    }),
    { key, entry: incoming, state: 'incoming' as const }
  ]
  const winner = revisions.reduce((latest, candidate) =>
    compareHookDeliveryRecency(candidate.entry.hookContext!, latest.entry.hookContext!) > 0 ? candidate : latest
  )
  return {
    winner,
    superseded: revisions.filter((candidate) => candidate !== winner)
  }
}

/** Per-key replacement queues once the superseded queued entries are dropped; `undefined` means delete the key. */
export function planQueuedRevisionRemovals(
  candidates: readonly HookQueueCandidate[],
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

export interface RevisionAdmissionEffects {
  /** Queued or incoming losers: removed from the queue and settled outright. */
  terminalLosers: HookQueueCandidate[]
  /** Losers already generating: their completion is awaited by the winner. */
  activeLosers: HookQueueCandidate[]
  /** Active losers a newer revision — or an explicit re-run of their own head — preempts. */
  preemptableActiveLosers: HookQueueCandidate[]
  /** Lane the winner belongs to, so its own re-admission survives the interrupt. */
  winnerLane: string | undefined
  /** The winner is not yet running, so it must absorb the losers' teardown waits. */
  winnerNeedsWait: boolean
  /** The caller's own entry won and may proceed. */
  incomingWins: boolean
}

export function planRevisionAdmissionEffects(
  plan: RevisionAdmissionPlan,
  incoming: QueueEntry
): RevisionAdmissionEffects {
  const winnerHook = plan.winner.entry.hookContext
  const admission = hookAdmissionFor(winnerHook)
  const winnerHead = admission?.headSha(winnerHook)
  const rerun = admission?.rerunsCurrentHead(winnerHook) === true
  const activeLosers = plan.superseded.filter((candidate) => candidate.state === 'active')
  return {
    terminalLosers: plan.superseded.filter((candidate) => candidate.state !== 'active'),
    activeLosers,
    preemptableActiveLosers: activeLosers.filter((candidate) => {
      const hook = candidate.entry.hookContext
      return rerun || hookAdmissionFor(hook)?.headSha(hook) !== winnerHead
    }),
    winnerLane: admission?.reviewSubjectLane(
      winnerHook,
      hookCoordinates(plan.winner.entry.agentId, plan.winner.entry.msg, plan.winner.entry.integrationId)
    ),
    winnerNeedsWait: plan.winner.state !== 'active',
    incomingWins: plan.winner.entry === incoming
  }
}

/** The stream identity one candidate's comment delivery coalesces into, if any. */
function candidateBatchStream(candidate: QueueEntry): string | undefined {
  const hook = candidate.hookContext
  return hookAdmissionFor(hook)?.reviewBatchStream(
    hook,
    hookCoordinates(candidate.agentId, candidate.msg, candidate.integrationId)
  )
}

/** Oldest open, unsealed, non-full batch on the incoming delivery's comment stream. */
export function selectReviewBatchLeader(
  incoming: QueueEntry,
  candidates: readonly HookQueueCandidate[]
): QueueEntry | undefined {
  const batchStream = candidateBatchStream(incoming)
  if (!batchStream) return undefined
  return candidates
    .map((candidate) => candidate.entry)
    .filter((candidate) => {
      const batch = candidate.hookContext?.githubReviewBatch
      return (
        !candidate.cancelledReason &&
        candidateBatchStream(candidate) === batchStream &&
        batch !== undefined &&
        !batch.sealed &&
        batch.items.length < REVIEW_BATCH_MAX_COMMENTS
      )
    })
    .sort((a, b) => compareHookDeliveryRecency(a.hookContext!, b.hookContext!))[0]
}

export interface ReviewBatchCoalescePlan {
  /** Leader hook context carrying the follower's delivery appended to the batch. */
  nextHook: HookDispatchContext
  /** Item identity folded in, for the operator log line. */
  itemKey: string
  reviewId: string
}

/** Decide whether a follower comment delivery folds into the leader's open batch. */
export function planReviewBatchCoalesce(
  leader: QueueEntry,
  follower: QueueEntry,
  now: number
): ReviewBatchCoalescePlan | undefined {
  const leaderHook = leader.hookContext
  const followerHook = follower.hookContext
  const leaderBatch = leaderHook?.githubReviewBatch
  const followerItem = followerHook?.githubReviewBatch?.items[0]
  const admission = hookAdmissionFor(leaderHook)
  if (!leaderHook || !followerHook || !leaderBatch || !followerItem || !admission) return undefined
  if (!leader.inboxId || !follower.inboxId) return undefined
  const followerKey = admission.batchItemKey(followerItem)
  if (
    leaderBatch.sealed ||
    leaderBatch.items.length >= REVIEW_BATCH_MAX_COMMENTS ||
    leaderBatch.items.some((item) => admission.batchItemKey(item) === followerKey)
  ) {
    return undefined
  }
  return {
    nextHook: {
      ...leaderHook,
      githubReviewBatch: { ...leaderBatch, updatedAt: now, items: [...leaderBatch.items, followerItem] }
    },
    itemKey: followerKey,
    reviewId: leaderBatch.reviewId
  }
}

export type ReviewBatchStep =
  /** Nothing left to settle; `clearReply` drops the single-delivery reply target the batch tool superseded. */
  | { action: 'stop'; clearReply: boolean }
  | { action: 'wait'; delayMs: number }
  /** Quiet or max-wait window elapsed; `promptText` is set only for a genuinely multi-delivery batch. */
  | { action: 'seal'; sealed: GithubReviewBatch; promptText?: string; clearReply: boolean }

/** One turn of the batch settle loop: stop, sleep until the next deadline, or seal. */
export function reviewBatchSettleStep(
  hook: HookDispatchContext | undefined,
  cancelled: boolean,
  now: number
): ReviewBatchStep {
  const batch = hook?.githubReviewBatch
  if (!batch) return { action: 'stop', clearReply: false }
  // Only a provider whose batch publishes each item itself withdraws the ordinary reply target.
  const toolOwnsReply = hookAdmissionFor(hook)?.batchPublishesItems === true
  if (batch.sealed) return { action: 'stop', clearReply: toolOwnsReply && batchNeedsOwnPrompt(batch) }
  if (cancelled) return { action: 'stop', clearReply: false }
  const deadline = Math.min(batch.updatedAt + REVIEW_BATCH_QUIET_MS, batch.openedAt + REVIEW_BATCH_MAX_WAIT_MS)
  const delayMs = deadline - now
  if (delayMs > 0) return { action: 'wait', delayMs }
  const sealed: GithubReviewBatch = { ...batch, sealed: true }
  const ownPrompt = batchNeedsOwnPrompt(sealed)
  return {
    action: 'seal',
    sealed,
    clearReply: toolOwnsReply && ownPrompt,
    ...(ownPrompt ? { promptText: hookAdmissionFor(hook)!.renderBatchPrompt(sealed) } : {})
  }
}
