/**
 * The per-family row shape (webhook-triggers-and-github-events.md). One row =
 * one subject family, so these predicates decide what a single row may carry.
 */
import { describe, it, expect } from 'vitest'
import {
  familyCarriesReviews,
  familyOfEventPattern,
  eventPatternFitsFamily,
  hasSharedCommentPattern,
  hookFamilyShapeError,
  hookSiblingShapeError,
  type HookFamily
} from './hook-family.js'

const shape = (over: Partial<Parameters<typeof hookFamilyShapeError>[0]> = {}) =>
  hookFamilyShapeError({
    kind: 'github',
    family: 'pull_request',
    events: ['pull_request:*'],
    commentFamilies: [],
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    ...over
  })

describe('hook family — pattern classification', () => {
  it('maps a stored pattern prefix onto its subject family', () => {
    expect(familyOfEventPattern('issues:opened')).toBe('issues')
    expect(familyOfEventPattern('pull_request:*')).toBe('pull_request')
    expect(familyOfEventPattern('merge_request:*')).toBe('merge_request')
    expect(familyOfEventPattern('push:*')).toBe('push')
    // A diff-line review comment is a pull-request subject…
    expect(familyOfEventPattern('pull_request_review_comment:created')).toBe('pull_request')
    // …but GitHub's shared conversation subscription names no subject by itself.
    expect(familyOfEventPattern('issue_comment:created')).toBeNull()
    expect(familyOfEventPattern('releases:published')).toBeNull()
  })

  it('admits the shared comment families only on the hosts and subjects that have them', () => {
    expect(eventPatternFitsFamily('github', 'issues', 'issue_comment:created')).toBe(true)
    expect(eventPatternFitsFamily('github', 'pull_request', 'issue_comment:created')).toBe(true)
    expect(eventPatternFitsFamily('github', 'push', 'issue_comment:created')).toBe(false)
    // GitLab notes are their own subscription, never a shared issue_comment one.
    expect(eventPatternFitsFamily('gitlab', 'issues', 'issue_comment:created')).toBe(false)
    expect(eventPatternFitsFamily('github', 'pull_request', 'pull_request_review_comment:created')).toBe(true)
    expect(eventPatternFitsFamily('github', 'issues', 'pull_request_review_comment:created')).toBe(false)
    expect(eventPatternFitsFamily('gitlab', 'merge_request', 'merge_request:*')).toBe(true)
    expect(eventPatternFitsFamily('gitlab', 'merge_request', 'issues:*')).toBe(false)
  })

  it('knows which families can carry reviews, and which patterns ride the shared subscription', () => {
    const carries: [HookFamily, boolean][] = [
      ['pull_request', true],
      ['merge_request', true],
      ['issues', false],
      ['push', false]
    ]
    for (const [family, expected] of carries) expect(familyCarriesReviews(family)).toBe(expected)
    expect(hasSharedCommentPattern(['pull_request:*', 'issue_comment:created'])).toBe(true)
    expect(hasSharedCommentPattern(['pull_request:*'])).toBe(false)
  })
})

describe('hook family — one-row shape', () => {
  it('accepts a row whose whole subscription belongs to its own family', () => {
    expect(shape()).toBeNull()
    expect(
      shape({
        events: ['pull_request:*', 'issue_comment:created', 'pull_request_review_comment:created'],
        commentFamilies: ['pull_request']
      })
    ).toBeNull()
    expect(
      shape({ family: 'issues', events: ['issues:*', 'issue_comment:created'], commentFamilies: ['issues'] })
    ).toBeNull()
    expect(shape({ family: 'push', events: ['push:*'] })).toBeNull()
    expect(
      shape({
        kind: 'gitlab',
        family: 'merge_request',
        events: ['merge_request:*'],
        commentFamilies: ['merge_request']
      })
    ).toBeNull()
  })

  it('names the offending pattern when it belongs to another family', () => {
    expect(shape({ events: ['pull_request:*', 'issues:opened'] })).toMatch(/"issues:opened".*pull_request family/)
    expect(shape({ family: 'push', events: ['push:*', 'issue_comment:created'] })).toMatch(/issue_comment:created/)
  })

  it('keeps commentFamilies inside the row it scopes', () => {
    expect(shape({ commentFamilies: ['issues'] })).toMatch(/not issues/)
    expect(shape({ family: 'push', commentFamilies: ['issues'], events: ['push:*'] })).toMatch(/not issues/)
  })

  it('refuses a GitHub issue_comment subscription with no scope — that is the repo-wide legacy meaning', () => {
    // Left empty, the sibling row that owns the other thread family would fire too.
    expect(shape({ events: ['pull_request:*', 'issue_comment:created'] })).toMatch(
      /must set commentFamilies to \["pull_request"\]/
    )
    // GitLab has no shared subscription, so an empty note scope is just "no notes".
    expect(shape({ kind: 'gitlab', family: 'merge_request', events: ['merge_request:*'] })).toBeNull()
  })

  it('confines the review and reporting axes to a change-proposal family', () => {
    const reviews = 'reviews and run reporting apply to pull-request/merge-request rows'
    expect(shape({ family: 'issues', events: ['issues:*'], reviewPolicy: 'comment' })).toBe(reviews)
    expect(shape({ family: 'issues', events: ['issues:*'], reportingMode: 'check' })).toBe(reviews)
    expect(shape({ family: 'push', events: ['push:*'], gateMode: 'required' })).toBe(reviews)
    expect(shape({ reviewPolicy: 'full', reportingMode: 'check' })).toBeNull()
    expect(
      shape({ kind: 'gitlab', family: 'merge_request', events: ['merge_request:*'], reviewPolicy: 'full' })
    ).toBeNull()
  })
})

describe('hook family — sibling anchoring', () => {
  const anchored = {
    targetPlatform: 'slack',
    targetChannel: 'C1',
    targetIntegrationId: 'i1',
    sessionMode: 'perThread'
  }

  it('accepts siblings that post to the same place (and the no-sibling case)', () => {
    expect(hookSiblingShapeError([], anchored, 'acme/infra')).toBeNull()
    expect(hookSiblingShapeError([anchored, anchored], { ...anchored }, 'acme/infra')).toBeNull()
  })

  it('refuses a divergent anchor on any leg of the trio', () => {
    for (const drift of [
      { targetPlatform: 'discord' },
      { targetChannel: 'C2' },
      { targetIntegrationId: 'i2' },
      { targetChannel: null },
      { sessionMode: 'shared' }
    ]) {
      expect(hookSiblingShapeError([{ ...anchored, ...drift }], anchored, 'acme/infra')).toMatch(
        /acme\/infra triggers post somewhere else/
      )
    }
  })
})
