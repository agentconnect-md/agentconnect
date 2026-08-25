import { describe, expect, it } from 'vitest'
import { githubProjectionIntent } from './projection-intent.js'

describe('githubProjectionIntent', () => {
  it('classifies revision-changing pull events consistently for delivery and completion recovery', () => {
    expect(githubProjectionIntent('pull_request:synchronize', { subjectKind: 'pull_request' })).toBe('revision_event')
  })

  it('projects only target-branch PR edits as revisions', () => {
    const changedBase = { subjectKind: 'pull_request', baseChanged: true }
    const unchangedBase = { subjectKind: 'pull_request', baseChanged: false }
    expect(githubProjectionIntent('pull_request:edited', changedBase)).toBe('revision_event')
    expect(githubProjectionIntent('pull_request:edited', unchangedBase)).toBe('review_action_only')
  })

  it.each([
    'pull_request:reopened',
    'pull_request:closed',
    'pull_request:ready_for_review',
    'pull_request:converted_to_draft'
  ])('keeps silent lifecycle event %s out of revision projection', (event) => {
    expect(githubProjectionIntent(event, { subjectKind: 'pull_request' })).toBe('review_action_only')
  })

  it('opens a new revision-style generation for an explicit Check rerequest', () => {
    expect(githubProjectionIntent('check_run:rerequested', { subjectKind: 'pull_request' })).toBe('revision_event')
    expect(githubProjectionIntent('check_suite:rerequested', { subjectKind: 'pull_request' })).toBe('revision_event')
    expect(githubProjectionIntent('check_run:requested_action', { subjectKind: 'pull_request' })).toBe('revision_event')
    expect(githubProjectionIntent('pull_request:review_requested', { subjectKind: 'pull_request' })).toBe(
      'revision_event'
    )
  })

  it('opens an explicit PR-comment review generation only when formal reviews are enabled', () => {
    expect(
      githubProjectionIntent(
        'issue_comment:created',
        {
          subjectKind: 'pull_request',
          explicitReviewRequest: true
        },
        'full'
      )
    ).toBe('revision_event')
    expect(
      githubProjectionIntent(
        'issue_comment:created',
        { subjectKind: 'pull_request', explicitReviewRequest: true },
        'off'
      )
    ).toBe('review_action_only')
    expect(githubProjectionIntent('issue_comment:created', { subjectKind: 'pull_request' })).toBe('review_action_only')
  })

  it('keeps non-revision PR actions review-only and non-PR subjects out of R2a', () => {
    expect(githubProjectionIntent('pull_request_review:submitted', { subjectKind: 'pull_request' })).toBe(
      'review_action_only'
    )
    expect(githubProjectionIntent('issues:opened', { subjectKind: 'issue' })).toBe('none')
    expect(githubProjectionIntent(undefined, undefined)).toBe('none')
  })
})
