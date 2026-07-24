import { describe, expect, it } from 'vitest'
import { inviteLinkStatus, inviteLinkUrl } from './org-invite-link'

describe('organization invite-link helpers', () => {
  it('shows an active link as expired once its deadline passes', () => {
    expect(inviteLinkStatus({ status: 'active', expiresAt: '2026-07-14T00:00:00.000Z' }, Date.UTC(2026, 6, 14))).toBe(
      'expired'
    )
    expect(inviteLinkStatus({ status: 'active', expiresAt: '2026-07-14T00:00:00.001Z' }, Date.UTC(2026, 6, 14))).toBe(
      'active'
    )
  })

  it('builds a same-origin join URL', () => {
    expect(inviteLinkUrl('abc_DEF-123', 'https://console.example.test/')).toBe(
      'https://console.example.test/join/abc_DEF-123'
    )
  })
})
