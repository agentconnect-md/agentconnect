import type { SessionContext } from './context.js'
import {
  parseGithubReviewThreadReplies,
  parseReviewComments,
  requireEnum,
  requireStringAllowEmpty
} from './validate.js'
import type {
  GithubReviewEffect,
  GithubReviewEvent,
  GithubReviewVerdict,
  SubmitGithubReviewInput
} from '../../github/review.js'

/** A formal PR review request with its caller identity/session coordinates
 * filled from the trusted MCP SessionContext. No GitHub target is model input. */
export interface SubmitGithubReviewReq extends SubmitGithubReviewInput {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
}

export interface ReplyGithubReviewThreadsReq {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  replies: Array<{ threadRootCommentId: string; body: string }>
}

export interface ReplyGithubReviewThreadsResult {
  replies: Array<{
    threadRootCommentId: string
    state: 'published' | 'settled' | 'ambiguous'
    commentId?: string
  }>
}

/** The GitHub-review deps. Both are optional: an ordinary daemon carries the tool
 *  descriptors but fails closed when the review seam is not wired. */
export interface GithubReviewDeps {
  /** Execute the R1 formal-review effect against the daemon-private active PR
   * turn. The implementation owns action-time CP authorization and head/base
   * fencing; ordinary sessions fail closed. */
  submitGithubReview?: (req: SubmitGithubReviewReq) => Promise<GithubReviewEffect>
  /** Publish the independently authored replies for one trusted inline-review batch. */
  replyGithubReviewThreads?: (req: ReplyGithubReviewThreadsReq) => Promise<ReplyGithubReviewThreadsResult>
}

// Structured formal PR review. Target identity is intentionally absent from
// args; the daemon recomputes the logical session key from these trusted
// SessionContext fields and resolves the CURRENT active hook turn.
export function submitGithubReview(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: GithubReviewDeps
): Promise<unknown> {
  if (!deps.submitGithubReview) throw new Error('formal GitHub reviews are unavailable on this daemon')
  const event = requireEnum<GithubReviewEvent>(args, 'event', ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'])
  const verdict = requireEnum<GithubReviewVerdict>(args, 'verdict', ['pass', 'fail', 'neutral'])
  const body = requireStringAllowEmpty(args, 'body')
  const comments = parseReviewComments(args.comments)
  return deps.submitGithubReview({
    agentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    event,
    verdict,
    body,
    ...(comments ? { comments } : {})
  })
}

export function replyGithubReviewThreads(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: GithubReviewDeps
): Promise<unknown> {
  if (!deps.replyGithubReviewThreads) throw new Error('batched GitHub review replies are unavailable on this daemon')
  return deps.replyGithubReviewThreads({
    agentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {}),
    replies: parseGithubReviewThreadReplies(args.replies)
  })
}
