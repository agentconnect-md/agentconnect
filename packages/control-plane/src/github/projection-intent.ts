import { isGithubPullRequestRevisionEvent, type HookReviewPolicy } from '@agentconnect.md/protocol'
import type { HookProjectionIntent } from '../persistence/ports.js'

const REVISION_EVENTS = new Set([
  // A user rerequest is a new review generation on the same revision. It must
  // reopen queued/in_progress before the terminal result replaces the old one.
  'check_run:rerequested',
  'check_suite:rerequested',
  'check_run:requested_action',
  'pull_request:review_requested'
])

/**
 * Classify the metadata-only GitHub event into its R2a projection lifecycle.
 * The helper is shared by delivery-first and completion-first persistence so a
 * lost `rc/run-report` cannot change the resulting Check semantics.
 */
export function githubProjectionIntent(
  event: string | undefined,
  github: { subjectKind: string; baseChanged?: boolean; explicitReviewRequest?: boolean } | undefined,
  reviewPolicy?: HookReviewPolicy
): HookProjectionIntent {
  if (github?.subjectKind !== 'pull_request') return 'none'
  if (
    (reviewPolicy !== undefined && reviewPolicy !== 'off' && github.explicitReviewRequest) ||
    isGithubPullRequestRevisionEvent(event, github) ||
    REVISION_EVENTS.has(event ?? '')
  )
    return 'revision_event'
  return 'review_action_only'
}
