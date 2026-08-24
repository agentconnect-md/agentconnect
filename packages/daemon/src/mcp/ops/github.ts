import { z } from 'zod'
import type { SessionContext } from './context.js'
import {
  optionalEnum,
  optionalPositiveInt,
  parseArgs,
  requiredEnum,
  requiredPositiveInt,
  requiredString,
  requiredStringAllowEmpty
} from './args.js'
import type { SubmitCodeReviewReq } from '../../codehost/review-adapter.js'

const REVIEW_SIDES = ['LEFT', 'RIGHT'] as const

/** One inline review comment; the per-index messages name the offending entry for the model. */
const REVIEW_COMMENT = z.object(
  {
    path: requiredString('path'),
    body: requiredString('body'),
    line: requiredPositiveInt('line'),
    side: requiredEnum('side', REVIEW_SIDES),
    startLine: optionalPositiveInt('startLine'),
    startSide: optionalEnum('startSide', REVIEW_SIDES)
  },
  {
    error: (issue) =>
      issue.code === 'invalid_type' ? `comments[${String(issue.path?.at(-1))}] must be an object` : undefined
  }
)

/** `submitCodeReview` arguments. `body` may be empty; the review target is never model input. */
export const SUBMIT_CODE_REVIEW_ARGS = z.object({
  event: requiredEnum('event', ['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
  verdict: requiredEnum('verdict', ['pass', 'fail', 'neutral']),
  body: requiredStringAllowEmpty('body'),
  comments: z
    .array(REVIEW_COMMENT, 'argument comments must be an array')
    .max(100, 'argument comments may contain at most 100 entries')
    .nullish()
    .transform((comments) => comments ?? undefined)
})

const REPLIES_ERROR = 'argument replies must be a non-empty array'

/** `replyGithubReviewThreads` arguments: one non-empty reply per authorized thread root. The
 *  per-entry checks run on the array so each message can name the offending index. */
export const REPLY_GITHUB_REVIEW_THREADS_ARGS = z.object({
  replies: z
    .array(
      z.object(
        { threadRootCommentId: requiredString('threadRootCommentId'), body: requiredString('body') },
        {
          error: (issue) =>
            issue.code === 'invalid_type' ? `replies[${String(issue.path?.at(-1))}] must be an object` : undefined
        }
      ),
      REPLIES_ERROR
    )
    .min(1, REPLIES_ERROR)
    .max(25, 'argument replies may contain at most 25 entries')
    .superRefine((replies, ctx) => {
      replies.forEach((reply, index) => {
        if (!/^[1-9]\d*$/.test(reply.threadRootCommentId)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'threadRootCommentId'],
            message: `replies[${index}].threadRootCommentId must be a positive decimal string`
          })
        }
        if (!reply.body.trim()) {
          ctx.addIssue({ code: 'custom', path: [index, 'body'], message: `replies[${index}].body must be non-empty` })
        }
      })
    })
})

/** The pre-promotion name of {@link SubmitCodeReviewReq}; the shape is unchanged. */
export type SubmitGithubReviewReq = SubmitCodeReviewReq

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

/** The formal-review deps. Both are optional: an ordinary daemon carries the tool
 *  descriptors but fails closed when the review seam is not wired. */
export interface GithubReviewDeps {
  /** Execute the formal-review effect against the daemon-private active hook turn.
   * The implementation routes by the turn's code host and owns action-time CP
   * authorization and revision fencing; ordinary sessions fail closed. */
  submitCodeReview?: (req: SubmitCodeReviewReq) => Promise<unknown>
  /** Publish the independently authored replies for one trusted inline-review batch. */
  replyGithubReviewThreads?: (req: ReplyGithubReviewThreadsReq) => Promise<ReplyGithubReviewThreadsResult>
}

// Structured formal code review. Target identity is intentionally absent from
// args; the daemon recomputes the logical session key from these trusted
// SessionContext fields and resolves the CURRENT active hook turn.
export function submitCodeReview(
  ctx: SessionContext,
  args: Record<string, unknown>,
  deps: GithubReviewDeps
): Promise<unknown> {
  if (!deps.submitCodeReview) throw new Error('formal code reviews are unavailable on this daemon')
  const { event, verdict, body, comments } = parseArgs(SUBMIT_CODE_REVIEW_ARGS, args)
  return deps.submitCodeReview({
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
    replies: parseArgs(REPLY_GITHUB_REVIEW_THREADS_ARGS, args).replies
  })
}
