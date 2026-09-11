/**
 * The normalized event vocabulary a Gitea delivery arrives with (gitea-integration.md §8), in one
 * place so admission, lifecycle pairing, and the prompt agree on it.
 *
 * Lifecycle deliveries carry the product families GitLab's ingress established (`merge_request:*`,
 * `issues:*`, `push`); comment-family deliveries keep Gitea's own event type — the relay keys every
 * decision on `X-Gitea-Event-Type`, and only that type separates a pull-request comment from an
 * issue comment or a review submission.
 */

/** Deliveries that establish a new pull-request head. */
export const GITEA_PULL_REVISION_EVENTS: ReadonlySet<string> = new Set([
  'merge_request:opened',
  'merge_request:synchronize'
])

/** Deliveries that re-run the head already current: a reviewer request naming the bot, or the console's re-run. */
export const GITEA_PULL_RERUN_EVENTS: ReadonlySet<string> = new Set([
  'merge_request:review_requested',
  'merge_request:rerun'
])

/** Deliveries that open a formal review generation for the current head (§10.3). */
export const GITEA_PULL_REVIEW_GENERATION_EVENTS: ReadonlySet<string> = new Set([
  ...GITEA_PULL_REVISION_EVENTS,
  ...GITEA_PULL_RERUN_EVENTS
])

/** The maintenance family (§8): a merged pull request and a closed issue retire the per-thread checkout. */
export const GITEA_PULL_MERGED_EVENT = 'merge_request:merged'
export const GITEA_ISSUE_CLOSED_EVENT = 'issues:closed'

/** Comment-family event types, by `X-Gitea-Event-Type`: a review submission is one delivery per submission (§8, §16). */
export const GITEA_COMMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'issue_comment',
  'pull_request_comment',
  'pull_request_review_comment',
  'pull_request_review_approved',
  'pull_request_review_rejected'
])

/** The event type of a normalized `type:action` event. */
export function giteaEventType(event: string | undefined): string | undefined {
  return event?.split(':', 1)[0]
}

/** True when this delivery is a person writing a comment or submitting a review on the subject. */
export function isGiteaCommentEvent(event: string | undefined): boolean {
  const type = giteaEventType(event)
  return type !== undefined && GITEA_COMMENT_EVENT_TYPES.has(type)
}
