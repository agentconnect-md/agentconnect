import type {
  GithubHookMetadata,
  GithubPublishedComment,
  GithubReviewAuthorized,
  HookConfigSnapshot,
  HookReport,
  HookReviewResult,
  RdMsgHook
} from '@agentconnect.md/protocol'
import type {
  GithubReviewEffect,
  GithubReviewEvent,
  GithubReviewTarget,
  GithubReviewVerdict
} from '../github/review.js'
import type { SessionWorktreeRemoval } from '../workspace/workspace-manager.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { QueueEntry } from './turn-types.js'

export function hookSnapshot(msg: RdMsgHook): HookConfigSnapshot | undefined {
  if (
    msg.configRevision === undefined ||
    msg.dispatchRevision === undefined ||
    msg.dispatchDaemonId === undefined ||
    msg.reviewPolicy === undefined ||
    msg.reportingMode === undefined ||
    msg.gateMode === undefined
  )
    return undefined
  return {
    configRevision: msg.configRevision,
    dispatchRevision: msg.dispatchRevision,
    dispatchDaemonId: msg.dispatchDaemonId,
    reviewPolicy: msg.reviewPolicy,
    reportingMode: msg.reportingMode,
    gateMode: msg.gateMode
  }
}

export function reviewPolicyAllows(policy: HookConfigSnapshot['reviewPolicy'], event: GithubReviewEvent): boolean {
  if (policy === 'full') return true
  if (policy === 'request_changes') return event === 'COMMENT' || event === 'REQUEST_CHANGES'
  if (policy === 'comment') return event === 'COMMENT'
  return false
}

export function reviewResultForWire(effect: GithubReviewEffect): HookReviewResult {
  if (effect.state === 'submitted') return effect
  return { state: effect.state, code: effect.code }
}

// Bound the correlated hook/report outbox drain. Each request may live through
// several CP retries, so admitting an unbounded retained backlog at reconnect
// would turn a long outage into a memory/socket fan-out spike.
export const MAX_HOOK_REPORT_INFLIGHT = 100

/** True when the CP can only be answering about a peer's dispatch. Unproven ownership
 *  counts as foreign: keeping a report body is always recoverable, nulling it is not. */
export function foreignHookDispatch(report: HookReport, daemonId?: string): boolean {
  return report.dispatchDaemonId !== undefined && report.dispatchDaemonId !== daemonId
}

export interface GithubReplyTarget {
  hookId: string
  repo: string
  number: number
  /** The review-comment delivery that triggered this turn (diagnostic identity). */
  reviewCommentId?: string
  /** Stable root of the GitHub inline-review thread; replies must target this id. */
  reviewThreadRootCommentId?: string
}

export interface GithubReviewBatchItem {
  deliveryKey: string
  firedAt: string
  text: string
  reply: GithubReplyTarget & { reviewThreadRootCommentId: string }
  publishState?: 'not_started' | 'in_flight' | 'settled'
  publishedComment?: GithubPublishedComment
}

export interface GithubReviewBatch {
  reviewId: string
  openedAt: number
  updatedAt: number
  sealed?: boolean
  items: GithubReviewBatchItem[]
}

/** Durable daemon-private hook identity; coalesced prompt excerpts stay local and HookReport omits them. */
export interface HookDispatchContext {
  hookId: string
  agentId: string
  deliveryKey: string
  firedAt: string
  event?: string
  snapshot?: HookConfigSnapshot
  github?: GithubHookMetadata
  githubReply?: GithubReplyTarget
  githubReviewBatch?: GithubReviewBatch
  turnStartedAt?: string
  reviewAttemptId?: string
  reviewRequestedEvent?: GithubReviewEvent
  reviewRequestedVerdict?: GithubReviewVerdict
  reviewResult?: HookReviewResult
  /** Latest body-free outcome retained for terminal hook/report even when a
   * proved no-effect reservation is released to permit a corrected retry. */
  reviewReportAttemptId?: string
  reviewReportResult?: HookReviewResult
  /** Exact body-free identity of the fallback comment published for this turn. */
  publishedComment?: GithubPublishedComment
}

export type GithubThreadWorktreeCleanup = 'pull_request_merged' | 'issue_closed' | 'issue_deleted'

const GITHUB_DELETED_HOOK_EVENTS = new Set([
  'issues:deleted',
  'pull_request:deleted',
  'issue_comment:deleted',
  'pull_request_review_comment:deleted'
])

export function githubDeletedHookEvent(hook: Pick<HookDispatchContext, 'event'> | undefined): boolean {
  return hook?.event !== undefined && GITHUB_DELETED_HOOK_EVENTS.has(hook.event)
}

export interface GithubHookCoordinates {
  agentId: string
  platform: string
  channel: string
  integrationId?: string
}

export type GithubCoordinatedHook = Pick<HookDispatchContext, 'hookId' | 'agentId' | 'event' | 'github'>

export function githubHookCoordinates(
  agentId: string,
  msg: Pick<NormalizedMessage, 'platform' | 'channel'>,
  integrationId?: string
): GithubHookCoordinates {
  return {
    agentId,
    platform: msg.platform,
    channel: msg.channel,
    ...(integrationId !== undefined ? { integrationId } : {})
  }
}

export function githubPullRequestLane(
  hook: GithubCoordinatedHook | undefined,
  coords: GithubHookCoordinates
): string | undefined {
  const github = hook?.github
  if (hook?.agentId !== coords.agentId || github?.subjectKind !== 'pull_request' || github.pullNumber === undefined)
    return undefined
  return JSON.stringify([
    hook.hookId,
    hook.agentId,
    github.repoId,
    github.pullNumber,
    coords.platform,
    coords.channel,
    coords.integrationId ?? null
  ])
}

export function githubPullRevisionStream(
  hook: GithubCoordinatedHook | undefined,
  coords: GithubHookCoordinates
): string | undefined {
  const lane = githubPullRequestLane(hook, coords)
  if (!lane || hook?.event !== 'pull_request:synchronize' || !hook.github?.headSha) return undefined
  return JSON.stringify(['revision', lane])
}

export function githubReviewBatchStream(
  hook: GithubCoordinatedHook | undefined,
  coords: GithubHookCoordinates
): string | undefined {
  const github = hook?.github
  const lane = githubPullRequestLane(hook, coords)
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

export function renderGithubReviewBatchPrompt(batch: GithubReviewBatch): string {
  const items = [...batch.items].sort(
    (a, b) => a.firedAt.localeCompare(b.firedAt) || a.deliveryKey.localeCompare(b.deliveryKey)
  )
  return [
    `GitHub submitted-review inline comment batch (review ${batch.reviewId})`,
    `Authorized thread roots: ${items.map((item) => item.reply.reviewThreadRootCommentId).join(', ')}`,
    '',
    ...items.flatMap((item, index) => [
      `===== REVIEW THREAD ${index + 1} · ROOT ${item.reply.reviewThreadRootCommentId} =====`,
      item.text,
      `===== END REVIEW THREAD ${index + 1} =====`,
      ''
    ]),
    'Inspect shared PR context once, then call `replyGithubReviewThreads` exactly once with one complete answer for every authorized root above. Do not omit, combine, or add roots. The tool owns all public replies; keep the final answer transcript-only.'
  ].join('\n')
}

export function compareGithubPullRevisionRecency(a: HookDispatchContext, b: HookDispatchContext): number {
  if (a.firedAt !== b.firedAt) return a.firedAt < b.firedAt ? -1 : 1
  if (a.deliveryKey === b.deliveryKey) return 0
  return a.deliveryKey < b.deliveryKey ? -1 : 1
}

/** Relay-authored lifecycle events that remove the isolated checkout without
 * opening a model turn. Pair the normalized event with trusted subject metadata
 * so an old or malformed frame cannot turn an ordinary hook into maintenance. */
export function githubThreadWorktreeCleanup(
  hook: Pick<HookDispatchContext, 'event' | 'github'> | undefined
): GithubThreadWorktreeCleanup | undefined {
  if (hook?.event === 'pull_request:merged' && hook.github?.subjectKind === 'pull_request') {
    return 'pull_request_merged'
  }
  if (hook?.event === 'issues:closed' && hook.github?.subjectKind === 'issue') return 'issue_closed'
  if (hook?.event === 'issues:deleted' && hook.github?.subjectKind === 'issue') return 'issue_deleted'
  return undefined
}

export type SessionWorktreeCleanupResult =
  SessionWorktreeRemoval | { outcome: 'active' } | { outcome: 'not_applicable' }

/** An ordinary comment is safe only when no formal attempt exists, or when the
 * latest/current attempt has a correlated, definite no-effect result. Any
 * unresolved or contradictory state fails closed because GitHub may already
 * own the public response. */
export function githubFallbackAllowed(hook: HookDispatchContext | undefined): boolean {
  if (!hook) return true

  const currentAttemptId = hook.reviewAttemptId
  const reportAttemptId = hook.reviewReportAttemptId
  const hasFormalState =
    currentAttemptId !== undefined ||
    reportAttemptId !== undefined ||
    hook.reviewResult !== undefined ||
    hook.reviewReportResult !== undefined
  if (!hasFormalState) return true

  if (currentAttemptId !== undefined) {
    if (reportAttemptId !== undefined) {
      return (
        reportAttemptId === currentAttemptId &&
        hook.reviewReportResult?.state === 'not_submitted' &&
        (hook.reviewResult === undefined || hook.reviewResult.state === 'not_submitted')
      )
    }
    return hook.reviewResult?.state === 'not_submitted'
  }

  return (
    reportAttemptId !== undefined &&
    hook.reviewReportResult?.state === 'not_submitted' &&
    (hook.reviewResult === undefined || hook.reviewResult.state === 'not_submitted')
  )
}

/** Select only an outcome that belongs to the current attempt, falling back to
 * the retained terminal outcome once no current reservation remains. */
export function githubReviewResultForCompletion(
  hook: HookDispatchContext
): { attemptId: string; result: HookReviewResult } | undefined {
  if (hook.reviewAttemptId !== undefined) {
    if (hook.reviewReportAttemptId === hook.reviewAttemptId && hook.reviewReportResult) {
      return { attemptId: hook.reviewAttemptId, result: hook.reviewReportResult }
    }
    if (hook.reviewReportAttemptId === undefined && hook.reviewResult) {
      return { attemptId: hook.reviewAttemptId, result: hook.reviewResult }
    }
    return undefined
  }
  if (hook.reviewReportAttemptId && hook.reviewReportResult) {
    return { attemptId: hook.reviewReportAttemptId, result: hook.reviewReportResult }
  }
  return undefined
}

export interface ActiveGithubTurnMeta {
  entry: QueueEntry
  hook: HookDispatchContext
  snapshot: HookConfigSnapshot
  repoId: string
  repoFullName: string
  pullNumber: number
  expectedHeadSha: string
  expectedBaseSha: string
  reportSha: string
  /** ACP session owning this turn, used only to build daemon-authored review attribution. */
  sessionId: string
  reviewState: 'idle' | 'submitting' | 'done'
}

export interface ActiveGithubReplyBatchMeta {
  entry: QueueEntry
  sessionId: string
  called: boolean
}

export const GITHUB_REVIEW_BATCH_QUIET_MS = 5_000
export const GITHUB_REVIEW_BATCH_MAX_WAIT_MS = 30_000
export const GITHUB_REVIEW_BATCH_MAX_COMMENTS = 25

/** Review-comment follow-ups already belong to one existing inline thread.
 * They may receive exactly one daemon-owned inline reply, but must never gain
 * authority to create a second, top-level formal PR review. */
export function isGithubReviewCommentHook(hook: HookDispatchContext): boolean {
  return (
    hook.event?.split(':', 1)[0] === 'pull_request_review_comment' ||
    hook.github?.reviewThreadRootCommentId !== undefined
  )
}

export function authorizedReviewTargetMatches(
  active: ActiveGithubTurnMeta,
  attemptId: string,
  authorized: GithubReviewAuthorized
): boolean {
  return (
    authorized.attemptId === attemptId &&
    authorized.repoId === active.repoId &&
    authorized.repoFullName.toLowerCase() === active.repoFullName.toLowerCase() &&
    authorized.pullNumber === active.pullNumber &&
    authorized.expectedHeadSha === active.expectedHeadSha &&
    authorized.expectedBaseSha === active.expectedBaseSha
  )
}

export function authorizedReviewTarget(
  active: ActiveGithubTurnMeta,
  attemptId: string,
  authorized: GithubReviewAuthorized,
  recovering = false
): GithubReviewTarget {
  return {
    token: authorized.token,
    repoFullName: authorized.repoFullName,
    pullNumber: authorized.pullNumber,
    expectedHeadSha: authorized.expectedHeadSha,
    expectedBaseSha: authorized.expectedBaseSha,
    hookId: active.hook.hookId,
    deliveryKey: active.hook.deliveryKey,
    attemptId,
    ...(recovering ? { recovering: true } : {})
  }
}

export interface GithubQueueCandidate {
  key: string
  entry: QueueEntry
  state: 'active' | 'queued' | 'incoming'
}

export interface GithubRevisionAdmissionPlan {
  winner: GithubQueueCandidate
  superseded: GithubQueueCandidate[]
}

/** The narrow persistence ownership needed to terminalize a hook delivery.
 * A live QueueEntry implements this, while startup replay can use the retained
 * inbox id directly without fabricating an in-memory turn. */
export interface HookCompletionOwner {
  inboxId?: string
  hookTerminalReceipt?: boolean
}
