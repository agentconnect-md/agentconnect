import { describe, expect, it } from 'vitest'
import {
  GL_DEFAULT_TRIGGER_MODE,
  GL_FAMILIES,
  GL_TRIGGER_LABEL,
  GL_TRIGGER_MODES,
  GL_TRIGGER_PILL,
  commentFamiliesForGitlabFamilies,
  eventsForGitlabFamilies,
  gitlabCadencePick,
  gitlabFamilyCarriesReviews,
  gitlabFamilySubscription,
  gitlabFamilyTile,
  gitlabHookFamily,
  gitlabHookNeedsNormalization,
  gitlabTriggerModeOf,
  gitlabTriggerTooltip,
  parseGitlabHookThread
} from './gitlab-events'

describe('GL_TRIGGER_LABEL', () => {
  it('speaks the same vocabulary as the GitHub form', () => {
    expect(GL_TRIGGER_LABEL.first).toBe('opened')
    expect(GL_TRIGGER_LABEL.every).toBe('any update')
    expect(GL_TRIGGER_LABEL.mention).toBe('@-mention')
  })

  it('opens every new subscription on the opening itself', () => {
    expect(GL_DEFAULT_TRIGGER_MODE).toBe('first')
    expect(GL_TRIGGER_LABEL[GL_DEFAULT_TRIGGER_MODE]).toBe('opened')
  })

  it('offers no label cadence — GitLab label events are not subscribed here', () => {
    expect(GL_TRIGGER_MODES).toEqual(['first', 'every', 'mention'])
  })
})

describe('GL_TRIGGER_PILL', () => {
  it('keeps mention as the last segment, worded like the IM bar', () => {
    expect(GL_TRIGGER_MODES[GL_TRIGGER_MODES.length - 1]).toBe('mention')
    expect(GL_TRIGGER_PILL.mention).toBe('@-mention')
  })

  it('names the agent in the per-segment hover copy', () => {
    expect(gitlabTriggerTooltip('first', 'reviewer')).toContain('@reviewer')
    expect(gitlabTriggerTooltip('mention', 'reviewer')).toContain('@reviewer')
    expect(gitlabTriggerTooltip('every', 'reviewer')).not.toContain('@')
  })

  it('admits the service-account broadcast and reviewer requests, without an absolute "only"', () => {
    const copy = gitlabTriggerTooltip('mention', 'reviewer')
    expect(copy).toContain('service account')
    expect(copy).toContain('reviewer request')
    expect(copy).not.toMatch(/\bonly\b/)
  })
})

describe('GL_FAMILIES', () => {
  it('offers the same two subjects GitHub does — pushes stay held back', () => {
    expect(GL_FAMILIES.map(({ fam }) => fam)).toEqual(['issues', 'merge_request'])
    expect(GL_FAMILIES.map(({ label }) => label)).toEqual(['Issues', 'Merge requests'])
  })
})

describe('gitlabFamilyTile', () => {
  it('still labels a stored push row the console never offers', () => {
    expect(gitlabFamilyTile('push')?.pill).toBe('Pushes')
    expect(gitlabFamilyTile('push')?.label).toBe('Pushes')
  })
})

describe('gitlabHookFamily', () => {
  it('reads the row’s own family, whatever its stored events look like', () => {
    expect(gitlabHookFamily({ family: 'issues', events: ['merge_request:*'] })).toBe('issues')
    expect(gitlabHookFamily({ family: 'push', events: [] })).toBe('push')
  })

  it('falls back to the events for a legacy row the split could not place', () => {
    expect(gitlabHookFamily({ family: null, events: ['merge_request:*'] })).toBe('merge_request')
    // Display order decides which family a legacy both-subject row shows as.
    expect(gitlabHookFamily({ family: null, events: ['merge_request:*', 'issues:*'] })).toBe('issues')
  })

  it('names no family for a note-only rule', () => {
    expect(gitlabHookFamily({ family: null, events: ['note:*'] })).toBeNull()
  })
})

describe('gitlabFamilySubscription', () => {
  it('scopes the note subscription to the row’s own family', () => {
    expect(gitlabFamilySubscription('merge_request', 'every')).toEqual({
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: false
    })
    expect(gitlabFamilySubscription('issues', 'mention')).toEqual({
      events: ['issues:*'],
      commentFamilies: ['issues'],
      mentionOnly: true
    })
  })

  it('clears the note family in created mode and on a push row', () => {
    expect(gitlabFamilySubscription('merge_request', 'first')).toEqual({
      events: ['merge_request:opened'],
      commentFamilies: [],
      mentionOnly: false
    })
    expect(gitlabFamilySubscription('push', 'every')).toEqual({
      events: ['push:*'],
      commentFamilies: [],
      mentionOnly: false
    })
  })

  it('never emits a pattern from another family', () => {
    for (const fam of ['issues', 'merge_request', 'push'] as const) {
      for (const mode of GL_TRIGGER_MODES) {
        expect(gitlabFamilySubscription(fam, mode).events.every((event) => event.startsWith(`${fam}:`))).toBe(true)
      }
    }
  })
})

describe('gitlabFamilyCarriesReviews', () => {
  it('confines reviews and the run note to the change-proposal subject', () => {
    expect(gitlabFamilyCarriesReviews('merge_request')).toBe(true)
    expect(gitlabFamilyCarriesReviews('issues')).toBe(false)
    expect(gitlabFamilyCarriesReviews('push')).toBe(false)
  })
})

describe('eventsForGitlabFamilies', () => {
  it('subscribes created mode to thread openings while leaving push as a wildcard', () => {
    expect(eventsForGitlabFamilies(['issues', 'merge_request', 'push'], 'first')).toEqual([
      'issues:opened',
      'merge_request:opened',
      'push:*'
    ])
  })

  it('widens updated mode to every supported action', () => {
    expect(eventsForGitlabFamilies(['issues', 'merge_request', 'push'], 'every')).toEqual([
      'issues:*',
      'merge_request:*',
      'push:*'
    ])
  })

  it('uses the same event subscriptions for mention and updated modes', () => {
    expect(eventsForGitlabFamilies(['issues', 'push'], 'mention')).toEqual(
      eventsForGitlabFamilies(['issues', 'push'], 'every')
    )
  })

  it('emits display order regardless of the order the boxes were ticked', () => {
    expect(eventsForGitlabFamilies(['push', 'merge_request', 'issues'], 'every')).toEqual([
      'issues:*',
      'merge_request:*',
      'push:*'
    ])
  })
})

describe('commentFamiliesForGitlabFamilies', () => {
  it('clears the note subscription in created mode — a reply then needs a summon', () => {
    expect(commentFamiliesForGitlabFamilies(['issues', 'merge_request'], 'first')).toEqual([])
  })

  it('scopes replies to the selected thread families in updated and mention modes', () => {
    expect(commentFamiliesForGitlabFamilies(['merge_request', 'push'], 'every')).toEqual(['merge_request'])
    expect(commentFamiliesForGitlabFamilies(['issues', 'merge_request'], 'mention')).toEqual([
      'issues',
      'merge_request'
    ])
  })

  it('returns an empty scope for a push-only subscription', () => {
    expect(commentFamiliesForGitlabFamilies(['push'], 'every')).toEqual([])
  })
})

describe('gitlabTriggerModeOf', () => {
  it('reads the stored encoding back into the displayed trigger', () => {
    expect(gitlabTriggerModeOf({ events: ['merge_request:opened'], mentionOnly: false })).toBe('first')
    expect(gitlabTriggerModeOf({ events: ['merge_request:*'], mentionOnly: false })).toBe('every')
    expect(gitlabTriggerModeOf({ events: ['merge_request:*'], mentionOnly: true })).toBe('mention')
  })

  it('lets the mentionOnly flag win over an opened-cadence encoding', () => {
    expect(gitlabTriggerModeOf({ events: ['issues:opened'], mentionOnly: true })).toBe('mention')
  })

  it('reads a push-only subscription as updated — pushes carry no opening', () => {
    expect(gitlabTriggerModeOf({ events: ['push:*'], mentionOnly: false })).toBe('every')
  })
})

describe('gitlabHookNeedsNormalization', () => {
  it('accepts every canonical console encoding', () => {
    expect(
      gitlabHookNeedsNormalization({
        events: ['merge_request:*'],
        commentFamilies: ['merge_request'],
        mentionOnly: false
      })
    ).toBe(false)
    expect(
      gitlabHookNeedsNormalization({ events: ['merge_request:opened'], commentFamilies: [], mentionOnly: false })
    ).toBe(false)
    expect(gitlabHookNeedsNormalization({ events: ['push:*'], commentFamilies: [], mentionOnly: false })).toBe(false)
  })

  it('flags a comment scope narrower than the subject selection', () => {
    expect(
      gitlabHookNeedsNormalization({
        events: ['issues:*', 'merge_request:*'],
        commentFamilies: ['issues'],
        mentionOnly: false
      })
    ).toBe(true)
  })

  it('flags a created-cadence rule that still subscribes to replies', () => {
    expect(
      gitlabHookNeedsNormalization({
        events: ['merge_request:opened'],
        commentFamilies: ['merge_request'],
        mentionOnly: false
      })
    ).toBe(true)
  })

  it('flags a finer family:action pattern no radio state emits', () => {
    expect(
      gitlabHookNeedsNormalization({
        events: ['merge_request:synchronize'],
        commentFamilies: ['merge_request'],
        mentionOnly: false
      })
    ).toBe(true)
  })

  it('leaves a note-only rule outside the console normalization model', () => {
    expect(gitlabHookNeedsNormalization({ events: [], commentFamilies: ['issues'], mentionOnly: false })).toBe(false)
  })
})

describe('parseGitlabHookThread', () => {
  it('names a rerunnable subject but never a branch', () => {
    expect(parseGitlabHookThread('gitlab:4210:merge_request:17')).toEqual({ kind: 'merge_request', iid: 17 })
    expect(parseGitlabHookThread('gitlab:4210:push:refs/heads/main')).toBeNull()
  })
})

describe('gitlabCadencePick', () => {
  const canonicalUpdated = {
    family: 'merge_request',
    events: ['merge_request:*'],
    commentFamilies: ['merge_request'] as const,
    mentionOnly: false
  }
  // A legacy row watching both subjects, with replies on issues only: no radio
  // state encodes it, and its family was never placed.
  const nonCollapsing = {
    family: null,
    events: ['issues:*', 'merge_request:*'],
    commentFamilies: ['issues'] as const,
    mentionOnly: false
  }

  it('writes nothing when the displayed cadence is picked on a canonical rule', () => {
    expect(gitlabCadencePick(canonicalUpdated, 'every')).toBeNull()
  })

  it('keeps the row’s immutable family and only moves the cadence', () => {
    expect(gitlabCadencePick(canonicalUpdated, 'first')).toEqual({ family: 'merge_request', mode: 'first' })
    expect(gitlabCadencePick(canonicalUpdated, 'mention')).toEqual({ family: 'merge_request', mode: 'mention' })
  })

  it('leaves a rule the trigger cannot express alone until a cadence is picked', () => {
    // Displaying it must not rewrite it — but the nearest state is still shown,
    // and re-picking that same state is the explicit opt-in that normalizes it
    // down to the one family the row can keep.
    expect(gitlabTriggerModeOf(nonCollapsing)).toBe('every')
    expect(gitlabHookNeedsNormalization(nonCollapsing)).toBe(true)
    expect(gitlabCadencePick(nonCollapsing, 'every')).toEqual({ family: 'issues', mode: 'every' })
  })

  it('writes no edit for a rule that names no subject at all', () => {
    expect(
      gitlabCadencePick({ family: null, events: ['note:*'], commentFamilies: [], mentionOnly: false }, 'mention')
    ).toBeNull()
  })
})
