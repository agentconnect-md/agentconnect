/**
 * The normalized event vocabulary a Gitea delivery arrives with (gitea-integration.md §8), in one
 * place so admission, lifecycle pairing, and the prompt agree on it.
 *
 * The relay normalizes to GitLab's provider-neutral names (`merge_request:*`, `issues:*`, `note:created`,
 * `push`, the maintenance pair) and adds the one family GitLab lacks: a review submission arrives as
 * `review:commented`, `review:approved`, or `review:changes_requested`, its verdict the only thing the
 * delivery carries beyond the summary. The envelope's `context.event` is the family, `context.action` the rest.
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

/** Comment-family deliveries on a subject: a person writing a comment, or submitting a review (one delivery per submission, §16). */
export const GITEA_COMMENT_EVENTS: ReadonlySet<string> = new Set([
  'note:created',
  'review:commented',
  'review:approved',
  'review:changes_requested'
])

/** The envelope families those deliveries carry in `context.event`, whose excerpt IS what the person said. */
export const GITEA_COMMENT_FAMILIES: readonly string[] = ['note', 'review']

/** True when this delivery is a person writing a comment or submitting a review on the subject. */
export function isGiteaCommentEvent(event: string | undefined): boolean {
  return event !== undefined && GITEA_COMMENT_EVENTS.has(event)
}
