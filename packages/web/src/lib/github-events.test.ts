import { describe, expect, it } from 'vitest'
import {
  commentFamiliesForFamilies,
  eventsForFamilies,
  GH_FAMILIES,
  GH_TRIGGER_LABEL,
  GH_TRIGGER_MODES,
  GH_TRIGGER_PILL,
  githubDefaultTriggerMode,
  githubFamilyCarriesReviews,
  githubFamilySubscription,
  githubFamilyTile,
  githubHookFamily,
  githubHookNeedsNormalization,
  githubMentionUsage,
  githubTriggerModes,
  githubTriggerTooltip,
  triggerModeOf,
  THREAD_COMMENT_EVENT
} from './github-events'

describe('GH_TRIGGER_LABEL', () => {
  it('opens a pull-request subscription on every update and every other one on the opening', () => {
    expect(githubDefaultTriggerMode('pull_request')).toBe('every')
    expect(GH_TRIGGER_LABEL[githubDefaultTriggerMode('pull_request')]).toBe('any update')
    expect(githubDefaultTriggerMode('issues')).toBe('first')
    expect(githubDefaultTriggerMode('push')).toBe('first')
    expect(GH_TRIGGER_LABEL[githubDefaultTriggerMode('issues')]).toBe('opened')
  })

  it('spells the cadences out for the create surfaces', () => {
    expect(GH_TRIGGER_LABEL.every).toBe('any update')
    expect(GH_TRIGGER_LABEL.labeled).toBe('labeled')
    expect(GH_TRIGGER_LABEL.mention).toBe('@-mention')
  })
})

describe('githubTriggerModes', () => {
  it('offers the label cadence on issues alone', () => {
    expect(githubTriggerModes('issues')).toEqual(['first', 'every', 'labeled', 'mention'])
    expect(githubTriggerModes('pull_request')).toEqual(['first', 'every', 'mention'])
    expect(githubTriggerModes('push')).toEqual(['first', 'every', 'mention'])
  })
})

describe('GH_TRIGGER_PILL', () => {
  it('keeps mention as the last segment, worded like the IM bar', () => {
    expect(GH_TRIGGER_MODES[GH_TRIGGER_MODES.length - 1]).toBe('mention')
    expect(GH_TRIGGER_PILL.mention).toBe('@-mention')
  })

  it('keeps the short forms the IM trigger bar shares', () => {
    expect(GH_TRIGGER_PILL.first).toBe('create')
    expect(GH_TRIGGER_PILL.every).toBe('update')
    expect(GH_TRIGGER_PILL.labeled).toBe('labeled')
  })

  it('names the agent in the per-segment hover copy', () => {
    expect(githubTriggerTooltip('first', 'reviewer')).toContain('@reviewer')
    expect(githubTriggerTooltip('mention', 'reviewer')).toContain('@reviewer')
    expect(githubTriggerTooltip('every', 'reviewer')).toBe(
      'Runs when an issue or PR is opened and on supported updates and replies (close, reopen and title/body edits are ignored).'
    )
  })

  it('offers the owner-qualified team form only for an organization-owned repository', () => {
    // No organization (a personal installation) ⇒ no team to name.
    expect(githubMentionUsage('reviewer')).toBe('Use @reviewer to trigger only this agent.')
    expect(githubMentionUsage('reviewer', null)).toBe('Use @reviewer to trigger only this agent.')
    const owned = githubMentionUsage('reviewer', 'acme')
    expect(owned).toContain('@reviewer')
    expect(owned).toContain('@acme/reviewer')
  })

  it('mention-mode copy admits the App broadcast and explicit App review requests, without an absolute "only"', () => {
    const copy = githubTriggerTooltip('mention', 'reviewer')
    expect(copy).toContain('GitHub App')
    expect(copy).toContain('review request')
    expect(copy).not.toMatch(/\bonly\b/)
  })
})

describe('GH_FAMILIES', () => {
  it('names each subject without promising signals its cadences do not carry', () => {
    expect(GH_FAMILIES.map(({ label }) => label)).toEqual(['Pull requests', 'Issues'])
  })

  it('omits the commit (push) family — the subscription flow is held back for now', () => {
    expect(GH_FAMILIES.map(({ fam }) => fam)).toEqual(['pull_request', 'issues'])
  })

  it('still labels a stored push row the console never offers', () => {
    expect(githubFamilyTile('push')?.pill).toBe('Commits')
  })
})

describe('githubHookFamily', () => {
  it('reads the row’s own family, whatever its stored events look like', () => {
    expect(githubHookFamily({ family: 'issues', events: ['pull_request:*'] })).toBe('issues')
    expect(githubHookFamily({ family: 'push', events: [] })).toBe('push')
  })

  it('falls back to the events for a legacy row the split could not place', () => {
    expect(githubHookFamily({ family: null, events: ['issues:*', THREAD_COMMENT_EVENT] })).toBe('issues')
    // Display order decides which family a legacy both-subject row shows as.
    expect(githubHookFamily({ family: null, events: ['issues:*', 'pull_request:*'] })).toBe('pull_request')
  })

  it('names no family for a comment-only rule', () => {
    expect(githubHookFamily({ family: null, events: [THREAD_COMMENT_EVENT] })).toBeNull()
  })
})

describe('githubFamilySubscription', () => {
  it('scopes the shared issue_comment subscription to the row’s own family', () => {
    // The CP 400s an `issue_comment` pattern whose commentFamilies is empty.
    expect(githubFamilySubscription('pull_request', 'every')).toEqual({
      events: ['pull_request:*', THREAD_COMMENT_EVENT],
      commentFamilies: ['pull_request'],
      mentionOnly: false
    })
    expect(githubFamilySubscription('issues', 'mention')).toEqual({
      events: ['issues:*', THREAD_COMMENT_EVENT],
      commentFamilies: ['issues'],
      mentionOnly: true
    })
  })

  it('drops replies in created mode and comments altogether on a push row', () => {
    expect(githubFamilySubscription('issues', 'first')).toEqual({
      events: ['issues:opened'],
      commentFamilies: ['issues'],
      mentionOnly: false
    })
    expect(githubFamilySubscription('push', 'every')).toEqual({
      events: ['push:*'],
      commentFamilies: [],
      mentionOnly: false
    })
  })

  it('compiles the label cadence to the bare label event, with no reply scope', () => {
    // A label is applied to a thread, not said in it — so no issue_comment
    // subscription and no commentFamilies to narrow one.
    expect(githubFamilySubscription('issues', 'labeled')).toEqual({
      events: ['issues:labeled'],
      commentFamilies: [],
      mentionOnly: false
    })
  })

  it('narrows to the opening for a family that has no label events', () => {
    // The console never offers `labeled` off the issues subject; a stray pick
    // must not compile `pull_request:labeled`, nor widen past what was picked.
    expect(githubFamilySubscription('pull_request', 'labeled')).toEqual(
      githubFamilySubscription('pull_request', 'first')
    )
  })

  it('never emits a pattern from another family', () => {
    for (const fam of ['pull_request', 'issues', 'push'] as const) {
      for (const mode of GH_TRIGGER_MODES) {
        const { events } = githubFamilySubscription(fam, mode)
        expect(events.every((event) => event.startsWith(`${fam}:`) || event === THREAD_COMMENT_EVENT)).toBe(true)
      }
    }
  })
})

describe('githubFamilyCarriesReviews', () => {
  it('confines reviews and Checks to the change-proposal subject', () => {
    expect(githubFamilyCarriesReviews('pull_request')).toBe(true)
    expect(githubFamilyCarriesReviews('issues')).toBe(false)
    expect(githubFamilyCarriesReviews('push')).toBe(false)
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

  it('accepts a canonical labeled row', () => {
    expect(githubHookNeedsNormalization({ events: ['issues:labeled'], commentFamilies: [], mentionOnly: false })).toBe(
      false
    )
    // A labeled row that also carries a reply scope is not what the console writes.
    expect(
      githubHookNeedsNormalization({ events: ['issues:labeled'], commentFamilies: ['issues'], mentionOnly: false })
    ).toBe(true)
  })
})

describe('triggerModeOf', () => {
  it('round-trips the label cadence, and only for the exact issues subscription', () => {
    expect(triggerModeOf({ events: ['issues:labeled'], mentionOnly: false })).toBe('labeled')
    // Anything wider than the bare label event is an update rule, not a label one.
    expect(triggerModeOf({ events: ['issues:labeled', THREAD_COMMENT_EVENT], mentionOnly: false })).toBe('every')
    expect(triggerModeOf({ events: ['pull_request:labeled'], mentionOnly: false })).toBe('every')
    // The mention flag still wins over every events shape.
    expect(triggerModeOf({ events: ['issues:labeled'], mentionOnly: true })).toBe('mention')
  })

  it('keeps reading the opened and updated encodings', () => {
    expect(triggerModeOf({ events: ['issues:opened'], mentionOnly: false })).toBe('first')
    expect(triggerModeOf({ events: ['issues:*', THREAD_COMMENT_EVENT], mentionOnly: false })).toBe('every')
  })
})
