import {
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
} from '@agentconnect.md/protocol'
import type { HookRunRecord } from '../persistence/ports.js'

export type ProjectionDesiredState =
  'queued' | 'in_progress' | 'success' | 'action_required' | 'neutral' | 'skipped' | 'failure' | 'timed_out'

export type HookRuntimeProjectionState = 'neutral' | 'skipped'

/**
 * Convert the daemon's operational turn outcome into the informational Check
 * projection. A failed agent run without a formal review verdict is not a code
 * review finding, so the HookRun remains failed for observability while the
 * informational Check completes as non-blocking.
 */
export function hookRuntimeProjectionState(outcome: {
  status: 'running' | 'success' | 'failed'
  reason?: string | null
}): HookRuntimeProjectionState | null {
  if (outcome.status === 'success') return 'neutral'
  if (outcome.status !== 'failed') return null
  return 'skipped'
}

function reviewDesiredState(run: HookRunRecord): ProjectionDesiredState | null {
  if (run.reviewEvent === 'REQUEST_CHANGES') return 'action_required'
  if (run.verdict === 'pass') return 'success'
  if (run.verdict === 'fail') return 'action_required'
  if (run.projectionIntent === 'review_action_only') return null
  if (run.verdict === 'neutral') return 'neutral'
  return null
}

/** Recompute projection authority from the locked current HookRun. Callers use
 * this to reject lifecycle edges captured before a concurrent recovery/result. */
export function authoritativeHookProjectionState(run: HookRunRecord): ProjectionDesiredState | null {
  const reviewState = run.reviewAttemptState === 'submitted' ? reviewDesiredState(run) : null
  if (reviewState) return reviewState
  if (run.projectionIntent === 'review_action_only') return null
  if (run.projectionIntent !== 'revision_event') return null
  if (run.reviewErrorCode) return 'failure'
  if (run.orphanedAt) return 'timed_out'
  const runtimeState = hookRuntimeProjectionState(run)
  if (runtimeState) return runtimeState
  return run.turnStartedAt ? 'in_progress' : 'queued'
}

/** Product-facing label for a skipped Check. Internal topology details stay in
 * HookRun.reason and never leak into the GitHub Checks surface.
 *
 * `output.title` is the only field of ours that GitHub renders in the
 * Conversation tab's check list, so the awaiting-a-maintainer title states the
 * one reachable entry point instead of only the requirement. The Checks tab
 * carries the rest (see `hookSkippedCheckGuidance`). Without a configured App
 * slug there is no handle to name, so the title falls back to the requirement. */
export function hookSkippedCheckLabel(reason?: string | null, appSlug?: string): string | null {
  if (reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE) return 'Agent unavailable'
  if (reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED)
    return appSlug ? `Comment @${appSlug} to start the review` : 'Review requires a maintainer request'
  if (
    !reason ||
    reason === HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED ||
    reason === HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
  )
    return null
  return 'Review could not be completed'
}

/** Markdown section appended to a skipped Check's summary, explaining how a
 * maintainer starts a review GitHub deliberately withheld from an external
 * author. GitHub renders `output.summary` only on the Checks tab — the same
 * surface that renders the `Request review` action — so this is where the why
 * and the second entry point belong. Naming the mention handle depends on a
 * configured App slug; the button is always available. */
export function hookSkippedCheckGuidance(reason?: string | null, appSlug?: string): string | null {
  if (reason !== HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED) return null
  const mention = appSlug ? `comment \`@${appSlug}\` on this pull request, or ` : ''
  return [
    '### How to start this review',
    "This pull request was opened from outside the repository's write boundary, so no agent ran. " +
      `To review it, ${mention}use the **Request review** button above. ` +
      'Either way needs write or admin access to this repository. GitHub Actions **Approve and run workflows** ' +
      'only authorizes Actions; it does not start this AgentConnect review.'
  ].join('\n\n')
}
