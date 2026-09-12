import { describe, expect, it } from 'vitest'
import {
  GT_FAMILIES,
  GT_TRIGGER_LABEL,
  GT_TRIGGER_MODES,
  GT_TRIGGER_PILL,
  commentFamiliesForGiteaFamilies,
  eventsForGiteaFamilies,
  giteaCadencePick,
  giteaDefaultTriggerMode,
  giteaFamilyCarriesReviews,
  giteaFamilySubscription,
  giteaFamilyTile,
  giteaHookFamily,
  giteaHookNeedsNormalization,
  giteaTriggerModeOf,
  giteaTriggerTooltip
} from './gitea-events'

describe('GT_TRIGGER_LABEL', () => {
  it('speaks the vocabulary the other two code hosts do', () => {
    expect(GT_TRIGGER_LABEL.first).toBe('opened')
    expect(GT_TRIGGER_LABEL.every).toBe('any update')
    expect(GT_TRIGGER_LABEL.mention).toBe('@-mention')
    expect(GT_TRIGGER_MODES).toEqual(['first', 'every', 'mention'])
    expect(GT_TRIGGER_PILL.mention).toBe('@-mention')
  })

  it('opens a pull-request subscription on every update and every other one on the opening', () => {
    expect(giteaDefaultTriggerMode('merge_request')).toBe('every')
    expect(giteaDefaultTriggerMode('issues')).toBe('first')
    expect(giteaDefaultTriggerMode('push')).toBe('first')
  })

  it('admits the organization bot’s broadcast and reviewer requests, without an absolute "only"', () => {
    const mention = giteaTriggerTooltip('mention', 'triager')
    expect(mention).toContain('@triager')
    expect(mention).toContain('Gitea bot')
    expect(mention).toContain('reviewer requests')
    expect(giteaTriggerTooltip('every', 'triager')).toContain('reviews')
  })
})

describe('GT_FAMILIES', () => {
  it('offers the same two subjects the other hosts do — pushes stay held back', () => {
    expect(GT_FAMILIES.map((entry) => entry.fam)).toEqual(['issues', 'merge_request'])
    // A pull request is the merge_request FAMILY on the wire, and a PR in the console's words.
    expect(giteaFamilyTile('merge_request')?.pill).toBe('PRs')
    expect(giteaFamilyTile('merge_request')?.label).toBe('Pull requests')
  })

  it('still labels a stored push row the console never offers', () => {
    expect(giteaFamilyTile('push')?.pill).toBe('Pushes')
  })

  it('confines reviews and the commit status to the change-proposal subject', () => {
    expect(giteaFamilyCarriesReviews('merge_request')).toBe(true)
    expect(giteaFamilyCarriesReviews('issues')).toBe(false)
    expect(giteaFamilyCarriesReviews('push')).toBe(false)
  })
})

describe('eventsForGiteaFamilies', () => {
  it('subscribes created mode to thread openings while leaving push as a wildcard', () => {
    expect(eventsForGiteaFamilies(['issues', 'merge_request', 'push'], 'first')).toEqual([
      'issues:opened',
      'merge_request:opened',
      'push:*'
    ])
  })

  it('widens updated and mention modes to every supported action', () => {
    expect(eventsForGiteaFamilies(['merge_request'], 'every')).toEqual(['merge_request:*'])
    expect(eventsForGiteaFamilies(['merge_request'], 'mention')).toEqual(['merge_request:*'])
  })

  it('emits display order regardless of the order the boxes were ticked', () => {
    expect(eventsForGiteaFamilies(['merge_request', 'issues'], 'every')).toEqual(['issues:*', 'merge_request:*'])
  })
})

describe('commentFamiliesForGiteaFamilies', () => {
  it('clears the comment subscription in created mode — a reply then needs a summon', () => {
    expect(commentFamiliesForGiteaFamilies(['issues', 'merge_request'], 'first')).toEqual([])
  })

  it('scopes replies to the selected thread families in updated and mention modes', () => {
    expect(commentFamiliesForGiteaFamilies(['merge_request'], 'every')).toEqual(['merge_request'])
    expect(commentFamiliesForGiteaFamilies(['issues'], 'mention')).toEqual(['issues'])
    // A push row has no thread to reply on.
    expect(commentFamiliesForGiteaFamilies(['push'], 'every')).toEqual([])
  })
})

describe('giteaFamilySubscription', () => {
  it('writes one family’s whole subscription block', () => {
    expect(giteaFamilySubscription('merge_request', 'mention')).toEqual({
      events: ['merge_request:*'],
      commentFamilies: ['merge_request'],
      mentionOnly: true
    })
  })
})

describe('giteaTriggerModeOf', () => {
  it('reads the stored encoding back into the displayed trigger', () => {
    expect(giteaTriggerModeOf({ events: ['issues:opened'], mentionOnly: false })).toBe('first')
    expect(giteaTriggerModeOf({ events: ['issues:*'], mentionOnly: false })).toBe('every')
    // The flag wins over an opened-cadence encoding.
    expect(giteaTriggerModeOf({ events: ['issues:opened'], mentionOnly: true })).toBe('mention')
  })
})

describe('giteaHookFamily', () => {
  it('reads the row’s own family, whatever its stored events look like', () => {
    expect(giteaHookFamily({ family: 'merge_request', events: ['issues:*'] })).toBe('merge_request')
  })

  it('falls back to the events for a legacy row the split could not place', () => {
    expect(giteaHookFamily({ family: null, events: ['merge_request:*'] })).toBe('merge_request')
    expect(giteaHookFamily({ family: null, events: [] })).toBeNull()
  })
})

describe('giteaHookNeedsNormalization', () => {
  it('accepts every canonical console encoding', () => {
    for (const fam of ['issues', 'merge_request'] as const) {
      for (const mode of GT_TRIGGER_MODES) {
        expect(giteaHookNeedsNormalization(giteaFamilySubscription(fam, mode)), `${fam}:${mode}`).toBe(false)
      }
    }
  })

  it('flags a created-cadence rule that still subscribes to replies', () => {
    expect(
      giteaHookNeedsNormalization({
        events: ['merge_request:opened'],
        commentFamilies: ['merge_request'],
        mentionOnly: false
      })
    ).toBe(true)
  })

  it('flags a finer family:action pattern no cadence emits', () => {
    expect(
      giteaHookNeedsNormalization({
        events: ['merge_request:synchronize'],
        commentFamilies: [],
        mentionOnly: false
      })
    ).toBe(true)
  })

  it('leaves a comment-only rule outside the console normalization model', () => {
    expect(giteaHookNeedsNormalization({ events: [], commentFamilies: ['issues'], mentionOnly: false })).toBe(false)
  })
})

describe('giteaCadencePick', () => {
  const canonical = { family: 'merge_request', ...giteaFamilySubscription('merge_request', 'every') }

  it('writes nothing when the displayed cadence is picked on a canonical rule', () => {
    expect(giteaCadencePick(canonical, 'every')).toBeNull()
  })

  it('keeps the row’s immutable family and only moves the cadence', () => {
    expect(giteaCadencePick(canonical, 'mention')).toEqual({ family: 'merge_request', mode: 'mention' })
  })

  it('normalizes a rule the trigger cannot express when its displayed cadence is re-picked', () => {
    const inexpressible = {
      family: 'merge_request',
      events: ['merge_request:synchronize'],
      commentFamilies: [],
      mentionOnly: false
    }
    expect(giteaCadencePick(inexpressible, 'every')).toEqual({ family: 'merge_request', mode: 'every' })
  })

  it('writes no edit for a rule that names no subject at all', () => {
    expect(giteaCadencePick({ family: null, events: [], commentFamilies: [], mentionOnly: false }, 'every')).toBeNull()
  })
})
