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
  gitlabFamilyToggle,
  gitlabHookNeedsNormalization,
  gitlabRowFamilies,
  gitlabTriggerModeOf,
  gitlabTriggerTooltip,
  parseGitlabHookThread
} from './gitlab-events'

describe('GL_TRIGGER_LABEL', () => {
  it('speaks the same vocabulary as the GitHub form', () => {
    expect(GL_TRIGGER_LABEL.first).toBe('created')
    expect(GL_TRIGGER_LABEL.every).toBe('updated')
    expect(GL_TRIGGER_LABEL.mention).toBe('mention only')
  })

  it('defaults new subscriptions to updated mode', () => {
    expect(GL_DEFAULT_TRIGGER_MODE).toBe('every')
    expect(GL_TRIGGER_LABEL[GL_DEFAULT_TRIGGER_MODE]).toBe('updated')
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
    expect(GL_FAMILIES.find(({ fam }) => fam === 'issues')?.desc).toBe('opened, labels, replies')
    expect(GL_FAMILIES.find(({ fam }) => fam === 'merge_request')?.desc).toBe('opened, new commits, replies')
  })
})

describe('gitlabRowFamilies', () => {
  it('shows only the offered subjects for a hook that never listened to pushes', () => {
    expect(gitlabRowFamilies(['merge_request:*']).map(({ fam }) => fam)).toEqual(['issues', 'merge_request'])
  })

  it('keeps the pushes toggle on a hook that already stores push events', () => {
    const rows = gitlabRowFamilies(['merge_request:*', 'push:*'])
    expect(rows.map(({ fam }) => fam)).toEqual(['issues', 'merge_request', 'push'])
    expect(rows.find(({ fam }) => fam === 'push')?.desc).toBe('commits pushed to a branch')
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

describe('gitlabFamilyToggle', () => {
  const updatedMr = { events: ['merge_request:*'], mentionOnly: false }

  it('adds and removes a subject while carrying the stored cadence along', () => {
    expect(gitlabFamilyToggle(updatedMr, 'issues')).toEqual({ families: ['issues', 'merge_request'], mode: 'every' })
    expect(gitlabFamilyToggle({ events: ['issues:opened', 'push:*'], mentionOnly: false }, 'push')).toEqual({
      families: ['issues'],
      mode: 'first'
    })
  })

  it('carries a stored push subscription through an edit that never mentioned it', () => {
    expect(gitlabFamilyToggle({ events: ['merge_request:*', 'push:*'], mentionOnly: false }, 'issues')).toEqual({
      families: ['issues', 'merge_request', 'push'],
      mode: 'every'
    })
  })

  it('refuses to unsubscribe the last remaining subject', () => {
    expect(gitlabFamilyToggle(updatedMr, 'merge_request')).toBeNull()
  })
})

describe('gitlabCadencePick', () => {
  const canonicalUpdated = {
    events: ['merge_request:*'],
    commentFamilies: ['merge_request'] as const,
    mentionOnly: false
  }
  // Replies on issues but not merge requests: no radio state encodes it.
  const nonCollapsing = {
    events: ['issues:*', 'merge_request:*'],
    commentFamilies: ['issues'] as const,
    mentionOnly: false
  }

  it('writes nothing when the displayed cadence is picked on a canonical rule', () => {
    expect(gitlabCadencePick(canonicalUpdated, 'every')).toBeNull()
  })

  it('rewrites the whole block when a different cadence is picked', () => {
    expect(gitlabCadencePick(canonicalUpdated, 'first')).toEqual({ families: ['merge_request'], mode: 'first' })
    expect(gitlabCadencePick(canonicalUpdated, 'mention')).toEqual({ families: ['merge_request'], mode: 'mention' })
  })

  it('leaves a rule the trigger cannot express alone until a cadence is picked', () => {
    // Displaying it must not rewrite it — but the nearest state is still shown,
    // and re-picking that same state is the explicit opt-in that normalizes.
    expect(gitlabTriggerModeOf(nonCollapsing)).toBe('every')
    expect(gitlabHookNeedsNormalization(nonCollapsing)).toBe(true)
    expect(gitlabCadencePick(nonCollapsing, 'every')).toEqual({
      families: ['issues', 'merge_request'],
      mode: 'every'
    })
  })

  it('never invents a subject the stored rule did not watch', () => {
    expect(gitlabCadencePick({ events: ['push:*'], commentFamilies: [], mentionOnly: false }, 'mention')).toEqual({
      families: ['push'],
      mode: 'mention'
    })
  })
})
