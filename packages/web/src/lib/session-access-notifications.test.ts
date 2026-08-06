import { describe, expect, it } from 'vitest'
import { sessionAccessNotifications } from '@/lib/session-access-notifications'

const orgPath = (path: string) => `/acme${path}`

describe('sessionAccessNotifications', () => {
  it('creates an actionable Lark quota notification for hidden sessions', () => {
    expect(
      sessionAccessNotifications('sessions', true, [{ provider: 'feishu', region: 'lark', reason: 'quota' }], orgPath)
    ).toEqual([
      {
        category: 'session_access',
        severity: 'warning',
        sourceKey: 'sessions:feishu:lark:quota',
        title: 'Lark API quota exhausted',
        message:
          'Affected sessions are hidden until an administrator increases the allowance or the monthly quota resets.',
        action: {
          label: 'Open Lark Admin',
          href: 'https://www.larksuite.com/admin',
          external: true
        }
      }
    ])
  })

  it('creates an actionable Feishu authorization notification for under-counted usage', () => {
    expect(
      sessionAccessNotifications(
        'usage',
        true,
        [{ provider: 'feishu', region: 'feishu', reason: 'authorization' }],
        orgPath
      )
    ).toEqual([
      {
        category: 'session_access',
        severity: 'warning',
        sourceKey: 'usage:feishu:feishu:authorization',
        title: 'Refresh your Feishu sign-in',
        message: 'Refresh this identity in Profile to restore usage from affected sessions.',
        action: {
          label: 'Refresh Feishu',
          href: '/acme/profile?reauthorize=feishu#sign-in-methods',
          external: false
        }
      }
    ])
  })

  it('collapses unsupported and unusable diagnostics into one generic source per surface', () => {
    expect(
      sessionAccessNotifications(
        'sessions',
        true,
        [
          { provider: 'linear', reason: 'authorization' },
          { provider: 'feishu', reason: 'quota' },
          { provider: 'feishu', region: 'lark', reason: 'unavailable' }
        ],
        orgPath
      )
    ).toEqual([
      {
        category: 'session_access',
        severity: 'warning',
        sourceKey: 'sessions:generic:unavailable',
        title: 'Session access checks unavailable',
        message: 'Affected sessions are hidden until access can be verified.'
      }
    ])
  })

  it('emits a generic source when degradation has no diagnostic details', () => {
    expect(sessionAccessNotifications('usage', true, [], orgPath)).toEqual([
      expect.objectContaining({
        sourceKey: 'usage:generic:unavailable',
        title: 'Usage access checks unavailable'
      })
    ])
  })

  it('deduplicates classified issues and keeps Session and Usage source keys distinct', () => {
    const issues = [
      { provider: 'feishu', region: 'lark', reason: 'quota' as const },
      { provider: 'feishu', region: 'lark', reason: 'quota' as const }
    ]

    expect(sessionAccessNotifications('sessions', true, issues, orgPath)).toHaveLength(1)
    expect(sessionAccessNotifications('sessions', true, issues, orgPath)[0]?.sourceKey).toBe(
      'sessions:feishu:lark:quota'
    )
    expect(sessionAccessNotifications('usage', true, issues, orgPath)[0]?.sourceKey).toBe('usage:feishu:lark:quota')
  })

  it('returns no notifications for an explicitly clean snapshot', () => {
    expect(
      sessionAccessNotifications('sessions', false, [{ provider: 'feishu', region: 'lark', reason: 'quota' }], orgPath)
    ).toEqual([])
  })
})
