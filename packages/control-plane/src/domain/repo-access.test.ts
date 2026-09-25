import { describe, expect, it } from 'vitest'
import { accessBelow, githubEffectsNeed } from './repo-access.js'

describe('repository access tiers', () => {
  it('orders read below comment below write', () => {
    expect(accessBelow('read', 'comment')).toBe(true)
    expect(accessBelow('comment', 'write')).toBe(true)
    expect(accessBelow('write', 'write')).toBe(false)
    expect(accessBelow('write', 'read')).toBe(false)
  })

  it('asks what the hook route gate asks of a row or grant', () => {
    expect(githubEffectsNeed({ reviewPolicy: 'off', reportingMode: 'off' })).toBe('read')
    expect(githubEffectsNeed({ reviewPolicy: 'comment', reportingMode: 'off' })).toBe('comment')
    expect(githubEffectsNeed({ reviewPolicy: 'request_changes', reportingMode: 'off' })).toBe('write')
    expect(githubEffectsNeed({ reviewPolicy: 'full', reportingMode: 'off' })).toBe('write')
    expect(githubEffectsNeed({ reviewPolicy: 'comment', reportingMode: 'check' })).toBe('write')
    expect(githubEffectsNeed({ reviewPolicy: 'off', reportingMode: 'check' })).toBe('write')
  })
})
