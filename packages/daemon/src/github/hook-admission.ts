/** GitHub's implementation of the daemon hook-admission contract (§6.5): pull-request
 *  lanes, check-run re-run semantics, and submitted-review inline-comment batching. */
import {
  codeHostLane,
  type CodeHostCoordinatedHook,
  type CodeHostHookAdmission,
  type CodeHostHookCoordinates,
  type CodeHostRevisionStream
} from '../codehost/hook-admission.js'
import type { GithubReviewBatch, GithubReviewBatchItem, HookDispatchContext } from './hook-coords.js'

/** Deliveries that establish a new head. */
const PULL_REVISION_EVENTS = new Set(['pull_request:opened', 'pull_request:synchronize'])

/** Deliveries that re-run the head already current; a burst of them is one review asked for repeatedly. */
const PULL_RERUN_EVENTS = new Set([
  'pull_request:review_requested',
  'check_run:rerequested',
  'check_suite:rerequested',
  'check_run:requested_action'
])

function pullRequestLane(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const github = hook?.github
  if (hook?.agentId !== coords.agentId || github?.subjectKind !== 'pull_request' || github.pullNumber === undefined)
    return undefined
  return codeHostLane(hook, github.repoId, github.pullNumber, coords)
}

function pullRevisionStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): CodeHostRevisionStream | undefined {
  const lane = pullRequestLane(hook, coords)
  const headSha = hook?.github?.headSha
  if (!lane || !headSha) return undefined
  const event = hook?.event ?? ''
  if (PULL_REVISION_EVENTS.has(event)) return { lane, headSha, pinned: false }
  if (PULL_RERUN_EVENTS.has(event)) return { lane, headSha, pinned: true }
  return undefined
}

/** One submitted review's inline threads: only a thread ROOT comment joins its review's batch. */
function reviewBatchStream(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  const github = hook?.github
  const lane = pullRequestLane(hook, coords)
  if (
    !github ||
    !lane ||
    hook?.event !== 'pull_request_review_comment:created' ||
    github.pullRequestReviewId === undefined ||
    github.reviewCommentId === undefined ||
    github.reviewThreadRootCommentId === undefined ||
    github.reviewCommentId !== github.reviewThreadRootCommentId
  ) {
    return undefined
  }
  return JSON.stringify(['review', lane, github.pullRequestReviewId])
}

/** Open the batch this delivery starts: only a trusted inline-thread root under a durable review id. */
function openReviewBatch(
  hook: HookDispatchContext,
  coords: CodeHostHookCoordinates,
  text: string,
  now: number
): GithubReviewBatch | undefined {
  const reply = hook.githubReply
  const reviewThreadRootCommentId = reply?.reviewThreadRootCommentId
  const reviewId = hook.github?.pullRequestReviewId
  if (!reviewBatchStream(hook, coords) || !reply || !reviewThreadRootCommentId || !reviewId) return undefined
  return {
    reviewId,
    openedAt: now,
    updatedAt: now,
    items: [
      {
        deliveryKey: hook.deliveryKey,
        firedAt: hook.firedAt,
        text,
        reply: { ...reply, reviewThreadRootCommentId },
        publishState: 'not_started'
      }
    ]
  }
}

/** A GitHub batch is only ever opened from a delivery carrying the trusted inline-thread root. */
function threadRoot(item: GithubReviewBatchItem): string {
  return item.reply!.reviewThreadRootCommentId
}

function renderGithubReviewBatchPrompt(batch: GithubReviewBatch): string {
  const items = [...batch.items].sort(
    (a, b) => a.firedAt.localeCompare(b.firedAt) || a.deliveryKey.localeCompare(b.deliveryKey)
  )
  return [
    `GitHub submitted-review inline comment batch (review ${batch.reviewId})`,
    `Authorized thread roots: ${items.map((item) => threadRoot(item)).join(', ')}`,
    '',
    ...items.flatMap((item, index) => [
      `===== REVIEW THREAD ${index + 1} · ROOT ${threadRoot(item)} =====`,
      item.text,
      `===== END REVIEW THREAD ${index + 1} =====`,
      ''
    ]),
    'Inspect shared PR context once, then call `replyGithubReviewThreads` exactly once with one complete answer for every authorized root above. Do not omit, combine, or add roots. The tool owns all public replies; keep the final answer transcript-only.'
  ].join('\n')
}

export const githubHookAdmission: CodeHostHookAdmission = {
  provider: 'github',
  claims: (hook) => hook?.github !== undefined,
  reviewSubjectLane: pullRequestLane,
  revisionStream: pullRevisionStream,
  headSha: (hook) => hook?.github?.headSha,
  rerunsCurrentHead: (hook: Pick<HookDispatchContext, 'event'> | undefined) => PULL_RERUN_EVENTS.has(hook?.event ?? ''),
  reviewBatchStream,
  openReviewBatch,
  batchItemKey: threadRoot,
  renderBatchPrompt: renderGithubReviewBatchPrompt,
  batchPublishesItems: true
}
