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

  // The whole point of the `app_authorization` variant: this state is a
  // two-minute administrator fix, and the generic copy below ("checks
  // unavailable") reads as a Slack outage and suggests nothing to do — so
  // people wait for something that never clears.
  it('turns a short Slack app grant into a reauthorize prompt', () => {
    expect(
      sessionAccessNotifications('sessions', true, [{ provider: 'slack', reason: 'app_authorization' }], orgPath)
    ).toEqual([
      {
        category: 'session_access',
        severity: 'warning',
        sourceKey: 'sessions:slack:app_authorization',
        title: 'Reauthorize your Slack app',
        message:
          'Refresh the app in Integrations to grant the permissions AgentConnect needs and restore access to affected sessions.',
        action: {
          label: 'Open Integrations',
          // Where the existing per-app refresh action lives, and the only place
          // that can say WHICH scopes an installation is missing.
          href: '/acme/integrations?platform=slack',
          external: false
        }
      }
    ])
  })

  it('phrases the Slack reauthorize prompt for the usage surface', () => {
    expect(
      sessionAccessNotifications('usage', true, [{ provider: 'slack', reason: 'app_authorization' }], orgPath)
    ).toEqual([
      expect.objectContaining({
        sourceKey: 'usage:slack:app_authorization',
        message:
          'Refresh the app in Integrations to grant the permissions AgentConnect needs and restore usage from affected sessions.'
      })
    ])
  })

  // Rate limiting, an outage or a timeout really do clear on their own. Sending
  // that reader to reauthorize an app would waste their time on a healthy one.
  it('keeps the generic copy for a transient Slack failure', () => {
    expect(
      sessionAccessNotifications('sessions', true, [{ provider: 'slack', reason: 'unavailable' }], orgPath)
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

  // Both halves of a mixed sweep are worth showing: one is actionable now, the
  // other explains the sessions that stay hidden after the app is fixed.
  it('shows the reauthorize prompt alongside the generic copy for a mixed sweep', () => {
    expect(
      sessionAccessNotifications(
        'sessions',
        true,
        [
          { provider: 'slack', reason: 'app_authorization' },
          { provider: 'slack', reason: 'unavailable' }
        ],
        orgPath
      ).map((notification) => notification.sourceKey)
    ).toEqual(['sessions:generic:unavailable', 'sessions:slack:app_authorization'])
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
