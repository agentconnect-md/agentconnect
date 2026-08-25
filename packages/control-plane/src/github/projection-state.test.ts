import {
  HOOK_DELIVERY_REASON_DAEMON_DRAINING,
  HOOK_DELIVERY_REASON_DAEMON_NOT_HOLDER,
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED,
  HOOK_REPORT_REASON_AGENT_HANDOVER,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
} from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { hookRuntimeProjectionState, hookSkippedCheckGuidance, hookSkippedCheckLabel } from './projection-state.js'

describe('hookRuntimeProjectionState', () => {
  it('keeps failed agent runs non-blocking without changing their operational status', () => {
    expect(hookRuntimeProjectionState({ status: 'failed', reason: HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED })).toBe(
      'skipped'
    )
    expect(hookRuntimeProjectionState({ status: 'failed', reason: HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED })).toBe(
      'skipped'
    )
    expect(hookRuntimeProjectionState({ status: 'failed', reason: 'session_start_failed' })).toBe('skipped')
    expect(hookRuntimeProjectionState({ status: 'failed', reason: 'turn_failed' })).toBe('skipped')
    expect(hookRuntimeProjectionState({ status: 'failed', reason: "You've hit your usage limit" })).toBe('skipped')
  })

  it('projects definite pre-dispatch unavailability without exposing topology', () => {
    expect(hookRuntimeProjectionState({ status: 'failed', reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE })).toBe(
      'skipped'
    )
    for (const reason of [
      HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
      HOOK_DELIVERY_REASON_DAEMON_DRAINING,
      HOOK_DELIVERY_REASON_DAEMON_NOT_HOLDER
    ]) {
      expect(hookSkippedCheckLabel(reason)).toBe('Agent unavailable')
    }
    expect(hookSkippedCheckLabel(HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED)).toBe(
      'Review requires a maintainer request'
    )
    expect(hookSkippedCheckLabel(HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED, 'example-app')).toBe(
      'Comment @example-app to start the review'
    )
    expect(hookSkippedCheckLabel('session_start_failed')).toBe('Review could not be completed')
    expect(hookSkippedCheckLabel(HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED)).toBeNull()
    expect(hookRuntimeProjectionState({ status: 'failed', reason: 'dispatch_timeout' })).toBe('skipped')
    expect(hookRuntimeProjectionState({ status: 'failed', reason: 'rejected:paused' })).toBe('skipped')
  })

  it('tells an interrupted review apart from a stop, and says how to run it again', () => {
    // The whole point of the distinct reason: a turn the infrastructure killed judged nothing, so
    // the maintainer gets an entry point instead of the generic "could not be completed".
    expect(hookRuntimeProjectionState({ status: 'failed', reason: HOOK_REPORT_REASON_AGENT_HANDOVER })).toBe('skipped')
    expect(hookSkippedCheckLabel(HOOK_REPORT_REASON_AGENT_HANDOVER)).toBe('Review was interrupted before it finished')
    expect(hookSkippedCheckLabel(HOOK_REPORT_REASON_AGENT_HANDOVER, 'example-app')).toBe(
      'Comment @example-app to retry the interrupted review'
    )
    // A user stop keeps the generic wording — there is nothing to retry on the maintainer's behalf.
    expect(hookSkippedCheckLabel('stop')).toBe('Review could not be completed')
    expect(hookSkippedCheckGuidance('stop')).toBeNull()

    const guidance = hookSkippedCheckGuidance(HOOK_REPORT_REASON_AGENT_HANDOVER, 'example-app')
    expect(guidance).toContain('How to run this review again')
    expect(guidance).toContain('@example-app')
    expect(guidance).toContain('**Request review**')
    // Never the internal reason, and never the topology behind it.
    expect(guidance).not.toContain(HOOK_REPORT_REASON_AGENT_HANDOVER)
    expect(guidance).not.toMatch(/daemon|lease|duty/i)
    // Without a configured App slug the button is still the reachable path.
    expect(hookSkippedCheckGuidance(HOOK_REPORT_REASON_AGENT_HANDOVER)).toContain('**Request review**')
    expect(hookSkippedCheckGuidance(HOOK_REPORT_REASON_AGENT_HANDOVER)).not.toContain('comment `@')
  })

  it('names every role that can actually start a review, on both guidance paths', () => {
    // This copy is the Checks tab, where a triage collaborator decides whether the button is for
    // them. Copy that undersells the gate turns the feature off in the only place it is read.
    for (const reason of [HOOK_DELIVERY_REASON_REVIEW_REQUEST_REQUIRED, HOOK_REPORT_REASON_AGENT_HANDOVER]) {
      const guidance = hookSkippedCheckGuidance(reason, 'example-app')
      expect(guidance).toContain('triage, write, or admin access')
      expect(guidance).not.toMatch(/needs write or admin/)
    }
  })

  it('preserves the existing success and running mappings', () => {
    expect(hookRuntimeProjectionState({ status: 'success' })).toBe('neutral')
    expect(hookRuntimeProjectionState({ status: 'running' })).toBeNull()
  })
})
