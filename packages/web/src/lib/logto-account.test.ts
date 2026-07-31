import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  getAccountToken: vi.fn(),
  getLogtoPublicConfig: vi.fn()
}))

vi.mock('@/lib/auth', () => auth)

describe('Logto Account API', () => {
  beforeEach(() => {
    auth.getAccountToken.mockReset().mockResolvedValue('opaque-account-token')
    auth.getLogtoPublicConfig.mockReset().mockReturnValue({
      endpoint: 'https://login.example.test/',
      appId: 'web-app'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reuses one ownership proof for a second link, until too little of its window is left', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
    vi.useFakeTimers()
    try {
      const { rememberOwnershipProof, reusableOwnershipProof, forgetOwnershipProof } = await import('./logto-account')

      rememberOwnershipProof('proof-1')
      expect(reusableOwnershipProof()).toBe('proof-1')

      // Still enough of the 10-minute window left to survive the provider trip.
      vi.advanceTimersByTime(4 * 60 * 1000)
      expect(reusableOwnershipProof()).toBe('proof-1')

      // Past the reuse budget: the proof would expire mid-consent, so a fresh
      // code is safer than a link that 403s on the way back.
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(reusableOwnershipProof()).toBeUndefined()

      // A refused proof is dropped rather than retried forever.
      rememberOwnershipProof('proof-2')
      expect(reusableOwnershipProof()).toBe('proof-2')
      forgetOwnershipProof()
      expect(reusableOwnershipProof()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a malformed or future-dated stored proof', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })
    const { reusableOwnershipProof } = await import('./logto-account')

    values.set('ac.social-link.proof', 'not json')
    expect(reusableOwnershipProof()).toBeUndefined()

    values.set('ac.social-link.proof', JSON.stringify({ recordId: 'x' }))
    expect(reusableOwnershipProof()).toBeUndefined()

    // A clock that jumped backwards must not mint an eternally valid proof.
    values.set('ac.social-link.proof', JSON.stringify({ recordId: 'x', createdAt: Date.now() + 60_000 }))
    expect(reusableOwnershipProof()).toBeUndefined()
  })

  it('keeps only the short-lived connector choice and CSRF state for the callback', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    })

    const { writeSocialLinkFlow, takeSocialLinkFlow } = await import('./logto-account')
    const flow = {
      state: 'state-123',
      connectorId: 'google-connector',
      verificationRecordId: 'verification-123',
      redirectUri: 'https://console.example.test/auth/social/callback',
      providerName: 'Google',
      returnTo: '/agentconnect/profile',
      createdAt: Date.now()
    }
    expect(writeSocialLinkFlow(flow)).toBe(true)
    expect(takeSocialLinkFlow()).toEqual(flow)
    expect(takeSocialLinkFlow()).toBeUndefined()
  })

  it('explains identity conflicts without offering account merging', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')

    expect(
      accountErrorMessage(new LogtoAccountError('identity already linked', 409, 'SOCIAL_IDENTITY_IN_USE'), {
        providerName: 'Google',
        linking: true
      })
    ).toBe('That Google account is already linked to another AgentConnect account.')
  })

  // Measured against a live tenant: a session opened before the deployment
  // granted the identities scope keeps working everywhere else, so "expired"
  // sends people to retry the same broken thing. Only a fresh sign-in helps.
  it('tells a scope-stale session to sign out rather than calling it expired', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')
    const unauthorized = new LogtoAccountError('unauthorized', 401)

    expect(accountErrorMessage(unauthorized, { providerName: 'Google', linking: true })).toBe(
      'This sign-in session cannot change sign-in methods. Sign out, sign in again, and retry.'
    )
    // Outside linking a 401 really is a dead session.
    expect(accountErrorMessage(unauthorized)).toBe('Your sign-in session expired. Sign in again and retry.')
  })
})
