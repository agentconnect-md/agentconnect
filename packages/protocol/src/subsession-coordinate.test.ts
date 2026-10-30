import { describe, expect, it } from 'vitest'
import { continuableSession } from './frames/route.js'
import { isDelegatedTaskCoordinate } from './subsession-coordinate.js'

describe('a delegated task coordinate (auto-session-mode.md §10)', () => {
  it('is a background coordinate other than a check, an approved proposal or research', () => {
    expect(isDelegatedTaskCoordinate('subsession:42')).toBe(true)
    for (const thread of [
      'subsession:check-1',
      'subsession:check-look-1',
      'subsession:task-1',
      'subsession:research-1'
    ])
      expect(isDelegatedTaskCoordinate(thread)).toBe(false)
    for (const thread of ['100.1', 'append:1', null, undefined]) expect(isDelegatedTaskCoordinate(thread)).toBe(false)
  })

  it('lets the console continue a delegated task on any surface, and no other background work', () => {
    expect(continuableSession({ platform: 'webchat', thread: 'subsession:42' })).toBe(true)
    expect(continuableSession({ platform: 'slack', thread: 'subsession:42' })).toBe(true)
    expect(continuableSession({ platform: 'slack', thread: 'subsession:check-1' })).toBe(false)
    expect(continuableSession({ platform: 'slack', thread: '100.1' })).toBe(true)
    expect(continuableSession({ platform: 'webchat', thread: 'webchat:c1' })).toBe(false)
    expect(continuableSession({ platform: 'dream', thread: null })).toBe(false)
  })
})
