/** §7 desired-events union: exactly what the enabled gitea hooks on a repository need, comments over-subscribed, compared by subset. */
import { describe, expect, it } from 'vitest'
import { giteaWebhookEventsHash, giteaWebhookEventsMissing, unionGiteaWebhookEvents } from './webhook-events.js'

const REPO = 556677n
const hook = (over: Partial<Parameters<typeof unionGiteaWebhookEvents>[0][number]> = {}) => ({
  enabled: true,
  kind: 'gitea' as const,
  repoId: REPO,
  events: ['issues:*'],
  commentFamilies: [],
  ...over
})

describe('unionGiteaWebhookEvents', () => {
  it('returns null when no enabled gitea hook targets the repository', () => {
    expect(unionGiteaWebhookEvents([], REPO)).toBeNull()
    expect(unionGiteaWebhookEvents([hook({ enabled: false })], REPO)).toBeNull()
    expect(unionGiteaWebhookEvents([hook({ kind: 'gitlab' })], REPO)).toBeNull()
    expect(unionGiteaWebhookEvents([hook({ repoId: 1n })], REPO)).toBeNull()
  })

  it('subscribes the issue family with its comment umbrella', () => {
    expect(unionGiteaWebhookEvents([hook()], REPO)).toEqual(['issues', 'issue_comment'])
  })

  it('subscribes the pull-request family to every review and comment name (§7 table)', () => {
    expect(unionGiteaWebhookEvents([hook({ events: ['merge_request:opened'] })], REPO)).toEqual([
      'issue_comment',
      'pull_request',
      'pull_request_sync',
      'pull_request_review_request',
      'pull_request_comment',
      'pull_request_review'
    ])
  })

  it('subscribes a push-only hook to push alone, and unions across hooks in a stable order', () => {
    expect(unionGiteaWebhookEvents([hook({ events: ['push:*'] })], REPO)).toEqual(['push'])
    const union = unionGiteaWebhookEvents(
      [hook({ events: ['push:*'] }), hook({ events: ['merge_request:*'] }), hook()],
      REPO
    )
    expect(union).toEqual([
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_sync',
      'pull_request_review_request',
      'pull_request_comment',
      'pull_request_review',
      'push'
    ])
  })

  it('a comment family on a push row over-subscribes the comment names it continues through', () => {
    expect(unionGiteaWebhookEvents([hook({ events: ['push:*'], commentFamilies: ['issues'] })], REPO)).toEqual([
      'issue_comment',
      'push'
    ])
    expect(unionGiteaWebhookEvents([hook({ events: ['push:*'], commentFamilies: ['merge_request'] })], REPO)).toEqual([
      'issue_comment',
      'pull_request_comment',
      'pull_request_review',
      'push'
    ])
  })
})

describe('giteaWebhookEventsMissing', () => {
  it('compares by subset: an expanded umbrella satisfies, a dropped name does not', () => {
    const stored = ['issues', 'issue_assign', 'issue_label', 'issue_milestone', 'issue_comment']
    expect(giteaWebhookEventsMissing(['issues', 'issue_comment'], stored)).toEqual([])
    expect(giteaWebhookEventsMissing(['issues', 'pull_request_review'], stored)).toEqual(['pull_request_review'])
    // A hook whose events came back empty stored nothing at all (§16).
    expect(giteaWebhookEventsMissing(['push'], [])).toEqual(['push'])
  })

  it('hashes the union by content, not by order', () => {
    expect(giteaWebhookEventsHash(['push', 'issues'])).toBe(giteaWebhookEventsHash(['issues', 'push']))
    expect(giteaWebhookEventsHash(['push'])).not.toBe(giteaWebhookEventsHash(['issues']))
  })
})
