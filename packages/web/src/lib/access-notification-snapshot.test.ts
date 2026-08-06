import { describe, expect, it } from 'vitest'
import { accessNotificationSnapshot } from '@/lib/access-notification-snapshot'

const settled = {
  authoritative: true,
  isLoading: false,
  isValidating: false,
  error: undefined
}

describe('accessNotificationSnapshot', () => {
  it('accepts an explicitly clean, settled, authoritative response', () => {
    expect(accessNotificationSnapshot({ accessSyncDegraded: false, accessIssues: [] }, settled)).toEqual({
      degraded: false,
      issues: []
    })
  })

  it('accepts a degraded response and preserves its diagnostics', () => {
    const issues = [{ provider: 'feishu', region: 'lark', reason: 'quota' as const }]
    expect(accessNotificationSnapshot({ accessSyncDegraded: true, accessIssues: issues }, settled)).toEqual({
      degraded: true,
      issues
    })
  })

  it('rejects older or partial responses with absent access diagnostics', () => {
    expect(accessNotificationSnapshot({}, settled)).toBeNull()
  })

  it.each([
    ['initial loading', { ...settled, isLoading: true }],
    ['active validation', { ...settled, isValidating: true }],
    ['request failure', { ...settled, error: new Error('failed') }],
    ['filtered or non-authoritative read', { ...settled, authoritative: false }]
  ])('rejects %s', (_label, state) => {
    expect(accessNotificationSnapshot({ accessSyncDegraded: false, accessIssues: [] }, state)).toBeNull()
  })
})
