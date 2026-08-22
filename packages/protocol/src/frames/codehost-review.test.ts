import { describe, expect, it } from 'vitest'
import {
  CODEHOST_REVIEW_V1_FEATURE,
  CodeHostReviewAuthorize,
  CodeHostReviewAuthorized,
  CodeHostReviewLeaseRenew,
  CodeHostReviewLeaseRenewed,
  CodeHostReviewOpAccepted,
  CodeHostReviewOpRequest,
  CodeHostReviewOpTarget,
  CodeHostReviewResultOk,
  CodeHostReviewResultReport,
  CodeHostReviewState,
  buildEnvelope,
  codeHostReviewPublicEffect,
  decodeEnvelope,
  encode,
  isFrame
} from '../index.js'

const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444'
const RECORD_ID = '55555555-5555-4555-8555-555555555555'
const START_TOKEN = '66666666-6666-4666-8666-666666666666'
const HEAD = 'a'.repeat(40)

const snapshot = {
  configRevision: '7',
  dispatchRevision: '9',
  dispatchDaemonId: DAEMON_ID,
  reviewPolicy: 'full' as const,
  reportingMode: 'off' as const,
  gateMode: 'informational' as const
}

const authorize = {
  hookId: HOOK_ID,
  deliveryKey: 'delivery-1',
  attemptId: ATTEMPT_ID,
  provider: 'gitlab',
  projectId: '4455667',
  mergeRequestIid: 42,
  requestedEvent: 'REQUEST_CHANGES' as const,
  requestedVerdict: 'fail' as const,
  snapshot,
  headSha: HEAD,
  serviceAccountIsReviewer: true
}

const grant = {
  attemptId: ATTEMPT_ID,
  fence: '3',
  leaseUntil: '2026-09-06T00:05:00.000Z',
  serviceAccountUserId: '99001'
}

describe('codehost review frames (gitlab-com-integration.md §15, §17.2)', () => {
  it('is gated by one feature string', () => {
    expect(CODEHOST_REVIEW_V1_FEATURE).toBe('codehost-review-v1')
  })

  it('round-trips the authorization request and its lease grant', () => {
    const req = decodeEnvelope(encode(buildEnvelope('codehost/review-authz', authorize, { orgId: 'org-1' })))
    expect(req.ok).toBe(true)
    if (!req.ok) return
    expect(isFrame('codehost/review-authz')(req.frame)).toBe(true)
    if (!isFrame('codehost/review-authz')(req.frame)) return
    expect(req.frame.payload.projectId).toBe('4455667')
    expect(req.frame.orgId).toBe('org-1')

    const rep = decodeEnvelope(
      encode(
        buildEnvelope(
          'codehost/review-authz/result',
          {
            authorized: true,
            attemptId: ATTEMPT_ID,
            provider: 'gitlab',
            projectId: '4455667',
            mergeRequestIid: 42,
            projectPath: 'example-group/example-project',
            expectedHeadSha: HEAD,
            lease: grant
          },
          { corr: req.frame.id, orgId: 'org-1' }
        )
      )
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('codehost/review-authz/result')(rep.frame)) return
    expect(rep.frame.payload.authorized).toBe(true)
    if (rep.frame.payload.authorized) expect(rep.frame.payload.lease.fence).toBe('3')
  })

  it('carries a typed refusal rather than an untyped failure', () => {
    const locked = CodeHostReviewAuthorized.safeParse({
      authorized: false,
      attemptId: ATTEMPT_ID,
      reason: 'ambiguous_locked',
      retryable: false
    })
    expect(locked.success).toBe(true)
    expect(
      CodeHostReviewAuthorized.safeParse({
        authorized: false,
        attemptId: ATTEMPT_ID,
        reason: 'force_unlocked',
        retryable: true
      }).success
    ).toBe(false)
  })

  it('rejects an authorization that names no head or a non-numeric project', () => {
    expect(CodeHostReviewAuthorize.safeParse({ ...authorize, headSha: '' }).success).toBe(false)
    expect(CodeHostReviewAuthorize.safeParse({ ...authorize, projectId: 'example/project' }).success).toBe(false)
    expect(CodeHostReviewAuthorize.safeParse({ ...authorize, mergeRequestIid: 0 }).success).toBe(false)
    // Additive fields degrade per-value: nothing here is strict (§17.2).
    expect(CodeHostReviewAuthorize.safeParse({ ...authorize, futureField: true }).success).toBe(true)
  })

  it('round-trips every operation-ledger op', () => {
    const issue = {
      op: 'issue' as const,
      attemptId: ATTEMPT_ID,
      fence: '3',
      kind: 'draft_create' as const,
      method: 'POST' as const,
      target: '/projects/4455667/merge_requests/42/draft_notes',
      ordinal: 0
    }
    expect(CodeHostReviewOpRequest.safeParse(issue).success).toBe(true)
    expect(
      CodeHostReviewOpRequest.safeParse({
        op: 'start',
        attemptId: ATTEMPT_ID,
        fence: '3',
        recordId: RECORD_ID,
        startToken: START_TOKEN
      }).success
    ).toBe(true)
    expect(
      CodeHostReviewOpRequest.safeParse({
        op: 'settle',
        attemptId: ATTEMPT_ID,
        fence: '3',
        recordId: RECORD_ID,
        outcome: { kind: 'deterministic', status: 201, externalId: '778899' }
      }).success
    ).toBe(true)
    expect(
      CodeHostReviewOpRequest.safeParse({
        op: 'settle',
        attemptId: ATTEMPT_ID,
        fence: '3',
        recordId: RECORD_ID,
        outcome: { kind: 'ambiguous', code: 'response_ambiguous' }
      }).success
    ).toBe(true)
    expect(
      CodeHostReviewOpRequest.safeParse({
        op: 'return-unused',
        attemptId: ATTEMPT_ID,
        fence: '3',
        recordId: RECORD_ID
      }).success
    ).toBe(true)
    // A start without its one-request token is not a start.
    expect(
      CodeHostReviewOpRequest.safeParse({ op: 'start', attemptId: ATTEMPT_ID, fence: '3', recordId: RECORD_ID }).success
    ).toBe(false)

    const decoded = decodeEnvelope(encode(buildEnvelope('codehost/review-op', issue, { orgId: 'org-1' })))
    expect(decoded.ok && isFrame('codehost/review-op')(decoded.frame)).toBe(true)
  })

  it('keeps the operation ledger body-free by construction', () => {
    expect(CodeHostReviewOpTarget.safeParse('/projects/1/merge_requests/2/draft_notes').success).toBe(true)
    expect(CodeHostReviewOpTarget.safeParse('projects/1/notes').success).toBe(false)
    expect(CodeHostReviewOpTarget.safeParse('/notes?body=looks good to me').success).toBe(false)
    expect(CodeHostReviewOpTarget.safeParse(`/${'a'.repeat(300)}`).success).toBe(false)
  })

  it('answers an op with the record state and the CP-derived lease phase', () => {
    expect(
      CodeHostReviewOpAccepted.safeParse({
        op: 'start',
        recordId: RECORD_ID,
        attemptId: ATTEMPT_ID,
        fence: '3',
        kind: 'bulk_publish',
        ordinal: 0,
        state: 'request_started',
        phase: 'publishing'
      }).success
    ).toBe(true)
    expect(
      CodeHostReviewOpAccepted.safeParse({
        op: 'start',
        recordId: RECORD_ID,
        attemptId: ATTEMPT_ID,
        fence: '3',
        kind: 'bulk_publish',
        ordinal: 0,
        state: 'force_unlocked',
        phase: 'publishing'
      }).success
    ).toBe(false)
  })

  it('renews only against an attempt and its fence', () => {
    expect(CodeHostReviewLeaseRenew.safeParse({ attemptId: ATTEMPT_ID, fence: '3' }).success).toBe(true)
    expect(CodeHostReviewLeaseRenew.safeParse({ attemptId: ATTEMPT_ID, fence: '-1' }).success).toBe(false)
    expect(
      CodeHostReviewLeaseRenewed.safeParse({
        attemptId: ATTEMPT_ID,
        fence: '3',
        leaseUntil: '2026-09-06T00:05:00.000Z',
        phase: 'classifying'
      }).success
    ).toBe(true)
  })

  it('classifies every normalized outcome for public effect', () => {
    for (const state of CodeHostReviewState.options) {
      expect(['present', 'absent', 'unknown']).toContain(codeHostReviewPublicEffect(state))
    }
    expect(codeHostReviewPublicEffect('submitted')).toBe('present')
    expect(codeHostReviewPublicEffect('approval_not_recorded')).toBe('present')
    expect(codeHostReviewPublicEffect('requested_changes_state_ambiguous')).toBe('present')
    expect(codeHostReviewPublicEffect('not_submitted')).toBe('absent')
    expect(codeHostReviewPublicEffect('reviewer_assignment_required')).toBe('absent')
    expect(codeHostReviewPublicEffect('ambiguous_locked')).toBe('unknown')
    expect(codeHostReviewPublicEffect('review_reconciliation_required')).toBe('unknown')
  })

  it('round-trips a result and refuses published ids on a proven no-effect outcome', () => {
    const result = {
      hookId: HOOK_ID,
      deliveryKey: 'delivery-1',
      attemptId: ATTEMPT_ID,
      snapshot,
      provider: 'gitlab',
      projectId: '4455667',
      mergeRequestIid: 42,
      event: 'REQUEST_CHANGES' as const,
      verdict: 'fail' as const,
      headSha: HEAD,
      state: 'requested_changes_block_observed' as const,
      externalIds: [{ kind: 'note' as const, externalId: '778899' }]
    }
    expect(CodeHostReviewResultReport.safeParse(result).success).toBe(true)
    expect(
      CodeHostReviewResultReport.safeParse({ ...result, state: 'not_submitted', externalIds: result.externalIds })
        .success
    ).toBe(false)
    expect(CodeHostReviewResultReport.safeParse({ ...result, state: 'not_submitted', externalIds: [] }).success).toBe(
      true
    )
    const decoded = decodeEnvelope(encode(buildEnvelope('codehost/review-result', result, { orgId: 'org-1' })))
    expect(decoded.ok && isFrame('codehost/review-result')(decoded.frame)).toBe(true)
    expect(CodeHostReviewResultOk.safeParse({ accepted: true, phase: 'settled' }).success).toBe(true)
  })

  it('has no field that could carry a review body', () => {
    const shape = Object.keys(CodeHostReviewResultReport._zod.def.shape ?? {})
    expect(shape).not.toContain('body')
    expect(shape).not.toContain('comments')
    expect(shape).not.toContain('summary')
  })
})
