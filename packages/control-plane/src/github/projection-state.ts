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
 * HookRun.reason and never leak into the GitHub Checks surface. */
export function hookSkippedCheckLabel(reason?: string | null): string | null {
  if (reason === HOOK_DELIVERY_REASON_DAEMON_OFFLINE) return 'Agent unavailable'
  if (reason === HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED) return 'Review requires a maintainer request'
  if (
    !reason ||
    reason === HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED ||
    reason === HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
  )
    return null
  return 'Review could not be completed'
}
