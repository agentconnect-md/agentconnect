import {
  codeHostReviewPublicEffect,
  type CodeHostReviewExternalRef,
  type CodeHostReviewOpKind,
  type CodeHostReviewOpOutcome,
  type CodeHostReviewState,
  type HookReviewEvent,
  type HookReviewVerdict,
  type GithubHookMetadata,
  type GitlabHookMetadata,
  type GithubPublishedComment,
  type PublishedHookOutput,
  type GithubReviewAuthorized,
  type HookConfigSnapshot,
  type HookReport,
  type HookReviewResult,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { GithubReviewEffect, GithubReviewEvent, GithubReviewTarget, GithubReviewVerdict } from './review.js'
import type { SessionWorktreeRemoval } from '../workspace/workspace-manager.js'
import type { QueueEntry } from '../daemon/turn-types.js'
import type { GitlabPublishFailure } from '../gitlab/poster.js'

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
  /** Provider discriminator: absent ⇒ github; 'gitlab' sets `repo` = numeric project id and `number` = the subject IID (§14.1). */
  provider?: 'gitlab'
  subjectKind?: 'issue' | 'merge_request'
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
  /** The per-item reply target, present only where the provider publishes each item itself. */
  reply?: GithubReplyTarget & { reviewThreadRootCommentId: string }
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

/** Bounded normalized note outcomes on the durable hook context (14.1); `publish_barrier_failed` is core's own — the poster was never reached. */
export type NotePublishFailure = GitlabPublishFailure | 'publish_barrier_failed'

const NOTE_PUBLISH_FAILURES = new Set<string>([
  'publish_timeout',
  'auth_rejected',
  'token_unavailable',
  'post_failed',
  'publish_barrier_failed'
] satisfies NotePublishFailure[])

/** Clamp a note outcome that round-tripped through the durable row's JSON back onto the bounded set. */
function notePublishFailureOf(value: unknown): NotePublishFailure | undefined {
  return typeof value === 'string' && NOTE_PUBLISH_FAILURES.has(value) ? (value as NotePublishFailure) : undefined
}

/** Terminal hook reason for a cleanly finished turn, undefined ⇒ success: an unfinished multi-reply review batch, else a final that never became a note (14.1 — a silently absent note must never read as a successful run). */
export function hookOutcomeFailure(
  batch: GithubReviewBatch | undefined,
  perItemPublication: boolean,
  notePublishFailure: unknown
): string | undefined {
  if (perItemPublication && batch && batch.items.length > 1) {
    if (batch.items.some((item) => item.publishState === 'in_flight')) return 'review_batch_publish_ambiguous'
    if (batch.items.some((item) => item.publishState !== 'settled')) return 'review_batch_replies_missing'
  }
  const code = notePublishFailureOf(notePublishFailure)
  return code ? `note_publish_failed:${code}` : undefined
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
  /** GitLab twin of `github` — the trusted subject discriminator (§12.3). */
  gitlab?: GitlabHookMetadata
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
  /** Provider-neutral twin (§14.1): e.g. the GitLab note id this turn published. */
  publishedOutput?: PublishedHookOutput
  /** The provider-neutral formal-review attempt (§15) — durable, so a replay cannot resurrect the fallback. */
  codeReview?: CodeReviewAttempt
  /** Its twin for an absent note — persisted WITH settlement so a replay cannot report success (§14.1). */
  notePublishFailure?: NotePublishFailure
}

/**
 * One reserved formal-review attempt, written to the durable hook row BEFORE the
 * first provider operation (§15). `state` appears only once the attempt is durably
 * classified; its absence means the effect is unknown and the ordinary reply is
 * blocked, exactly as an uncorrelated GitHub attempt is.
 */
export interface CodeReviewAttempt {
  attemptId: string
  event: HookReviewEvent
  verdict: HookReviewVerdict
  headSha: string
  state?: CodeHostReviewState
  /** The publication lease's fence, so an owed ledger frame stays derivable after a restart. */
  fence?: string
  /** Published objects this attempt named; replayed verbatim with a reconstructed result. */
  externalIds?: CodeHostReviewExternalRef[]
  /** The classification exists but the control plane has not taken it yet (§15.1). */
  resultOwed?: boolean
  /** Next operation-ledger ordinal per kind — monotonic, so a replay never reuses a spent coordinate. */
  ordinals?: Record<string, number>
  /** Operations whose one outbound request was permitted but not yet settled (§15.1). */
  operations?: CodeReviewOperation[]
}

/**
 * The coordinates of ONE permitted provider request, written before it is sent.
 *
 * `phase` is the LOCAL view of the control plane's record: `issued` means the start
 * transition had not been acknowledged, so a replay returns the permit unused rather
 * than settling a record no request was ever permitted under.
 */
export interface CodeReviewOperation {
  recordId: string
  startToken: string
  kind: CodeHostReviewOpKind
  ordinal: number
  target: string
  phase: 'issued' | 'started'
  /** The settle this operation owes, kept here when its frame could not be made durable —
   *  a restart replays it from these coordinates alone, with no provider evidence. */
  outcome?: CodeHostReviewOpOutcome
  /** Draft ordinal for a `draft_create`, so its marker can identify the effect on replay. */
  draftOrdinal?: number
}

/** §15.2 single-writer gate: only a PROVEN no-effect attempt leaves the ordinary reply available. */
export function codeHostReviewFallbackAllowed(hook: HookDispatchContext | undefined): boolean {
  const attempt = hook?.codeReview
  if (!attempt) return true
  return attempt.state !== undefined && codeHostReviewPublicEffect(attempt.state) === 'absent'
}

/** THE gate the turn-final surface asks: may the daemon still publish its ordinary reply?
 *  Either provider's unresolved formal attempt is enough to answer no. */
export function hookOutputFallbackAllowed(hook: HookDispatchContext | undefined): boolean {
  return githubFallbackAllowed(hook) && codeHostReviewFallbackAllowed(hook)
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

/** Relay-authored lifecycle events that remove the isolated checkout without
 * opening a model turn. Pair the normalized event with trusted subject metadata
 * so an old or malformed frame cannot turn an ordinary hook into maintenance. */
export function githubThreadWorktreeCleanup(
  hook: Pick<HookDispatchContext, 'event' | 'github' | 'gitlab'> | undefined
): GithubThreadWorktreeCleanup | undefined {
  if (hook?.event === 'pull_request:merged' && hook.github?.subjectKind === 'pull_request') {
    return 'pull_request_merged'
  }
  if (hook?.event === 'issues:closed' && hook.github?.subjectKind === 'issue') return 'issue_closed'
  if (hook?.event === 'issues:deleted' && hook.github?.subjectKind === 'issue') return 'issue_deleted'
  // The GitLab counterpart (gitlab-com-integration.md §12): merged MRs and
  // closed issues retire the per-thread checkout, fenced on the SAME pairing of
  // normalized event + trusted subject metadata.
  if (hook?.event === 'merge_request:merged' && hook.gitlab?.target.kind === 'merge_request') {
    return 'pull_request_merged'
  }
  if (hook?.event === 'issues:closed' && hook.gitlab?.target.kind === 'issue') return 'issue_closed'
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

/** The narrow persistence ownership needed to terminalize a hook delivery.
 * A live QueueEntry implements this, while startup replay can use the retained
 * inbox id directly without fabricating an in-memory turn. */
export interface HookCompletionOwner {
  inboxId?: string
  hookTerminalReceipt?: boolean
}
