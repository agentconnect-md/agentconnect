import { describe, expect, it } from 'vitest'
import {
  commentFamiliesForFamilies,
  eventsForFamilies,
  GH_DEFAULT_TRIGGER_MODE,
  GH_FAMILIES,
  GH_TRIGGER_LABEL,
  GH_TRIGGER_MODES,
  GH_TRIGGER_PILL,
  githubHookNeedsNormalization,
  githubTriggerTooltip,
  THREAD_COMMENT_EVENT
} from './github-events'

describe('GH_TRIGGER_LABEL', () => {
  it('defaults new subscriptions to updated mode', () => {
    expect(GH_DEFAULT_TRIGGER_MODE).toBe('every')
    expect(GH_TRIGGER_LABEL[GH_DEFAULT_TRIGGER_MODE]).toBe('updated')
  })

  it('makes the restrictive mention mode explicit', () => {
    expect(GH_TRIGGER_LABEL.mention).toBe('mention only')
  })
})

describe('GH_TRIGGER_PILL', () => {
  it('keeps mention as the last segment, worded like the IM bar', () => {
    expect(GH_TRIGGER_MODES[GH_TRIGGER_MODES.length - 1]).toBe('mention')
    expect(GH_TRIGGER_PILL.mention).toBe('@-mention')
  })

  it('names the agent in the per-segment hover copy', () => {
    expect(githubTriggerTooltip('first', 'reviewer')).toContain('@reviewer')
    expect(githubTriggerTooltip('mention', 'reviewer')).toContain('@reviewer')
    expect(githubTriggerTooltip('every', 'reviewer')).toBe(
      'Runs when an issue or PR is opened and on supported updates and replies (close, reopen and title/body edits are ignored).'
    )
  })

  it('mention-mode copy admits the App broadcast and explicit App review requests, without an absolute "only"', () => {
    const copy = githubTriggerTooltip('mention', 'reviewer')
    expect(copy).toContain('GitHub App')
    expect(copy).toContain('review request')
    expect(copy).not.toMatch(/\bonly\b/)
  })
})

describe('GH_FAMILIES', () => {
  it('describes the supported update signals without promising silent lifecycle or metadata events', () => {
    expect(GH_FAMILIES.find(({ fam }) => fam === 'pull_request')?.desc).toBe('opened, revision changes, replies')
    expect(GH_FAMILIES.find(({ fam }) => fam === 'issues')?.desc).toBe('opened, labels, replies')
  })

  it('omits the commit (push) family — the subscription flow is held back for now', () => {
    expect(GH_FAMILIES.map(({ fam }) => fam)).toEqual(['pull_request', 'issues'])
  })
})

describe('commentFamiliesForFamilies', () => {
  it('keeps the selected issue and PR families while excluding push', () => {
    expect(commentFamiliesForFamilies(['issues', 'push', 'pull_request'])).toEqual(['issues', 'pull_request'])
  })

  it('returns an empty scope when no thread family is selected', () => {
    expect(commentFamiliesForFamilies(['push'])).toEqual([])
  })
})

describe('eventsForFamilies', () => {
  it('subscribes created mode to thread openings while leaving push as a wildcard', () => {
    expect(eventsForFamilies(['issues', 'pull_request', 'push'], 'first')).toEqual([
      'issues:opened',
      'pull_request:opened',
      'push:*'
    ])
  })

  it('includes issue and PR replies in updated mode', () => {
    expect(eventsForFamilies(['issues'], 'every')).toEqual(['issues:*', THREAD_COMMENT_EVENT])
    expect(eventsForFamilies(['pull_request'], 'every')).toEqual(['pull_request:*', THREAD_COMMENT_EVENT])
    expect(eventsForFamilies(['issues', 'pull_request'], 'every')).toEqual([
      'issues:*',
      'pull_request:*',
      THREAD_COMMENT_EVENT
    ])
  })

  it('does not subscribe a push-only integration to issue comments', () => {
    expect(eventsForFamilies(['push'], 'every')).toEqual(['push:*'])
  })

  it('uses the same event subscriptions for mention and updated modes', () => {
    expect(eventsForFamilies(['issues', 'pull_request', 'push'], 'mention')).toEqual(
      eventsForFamilies(['issues', 'pull_request', 'push'], 'every')
    )
  })
})

describe('githubHookNeedsNormalization', () => {
  it('flags legacy updated and mention encodings that lack canonical replies/scope', () => {
    expect(githubHookNeedsNormalization({ events: ['issues:*'], commentFamilies: [], mentionOnly: false })).toBe(true)
    expect(
      githubHookNeedsNormalization({
        events: ['issues:*', THREAD_COMMENT_EVENT],
        commentFamilies: [],
        mentionOnly: true
      })
    ).toBe(true)
  })

  it('accepts canonical updated and created encodings', () => {
    expect(
      githubHookNeedsNormalization({
        events: ['issues:*', THREAD_COMMENT_EVENT],
        commentFamilies: ['issues'],
        mentionOnly: false
      })
    ).toBe(false)
    expect(
      githubHookNeedsNormalization({
        events: ['pull_request:opened'],
        commentFamilies: ['pull_request'],
        mentionOnly: false
      })
    ).toBe(false)
  })

  it('leaves raw API comment-only rules outside the console normalization model', () => {
    expect(
      githubHookNeedsNormalization({ events: [THREAD_COMMENT_EVENT], commentFamilies: [], mentionOnly: false })
    ).toBe(false)
  })
})
