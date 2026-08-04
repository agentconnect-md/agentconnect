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

  it('renews an existing social token set without exposing the returned provider token', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: 'new-provider-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchImpl)
    const { renewSocialIdentityToken } = await import('./logto-account')

    await expect(renewSocialIdentityToken('lark', 'social-verification')).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://login.example.test/api/my-account/identities/lark/access-token'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ verificationRecordId: 'social-verification' }),
        headers: expect.any(Headers)
      })
    )
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer opaque-account-token')
  })

  it('explains identity conflicts without offering account merging', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')

    expect(
      accountErrorMessage(new LogtoAccountError('identity already linked', 409, 'SOCIAL_IDENTITY_IN_USE'), {
        providerName: 'Google',
        operation: 'link'
      })
    ).toBe('That Google account is already linked to another AgentConnect account.')
  })

  it('explains that reconnecting with another provider account cannot replace the linked identity', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')

    expect(
      accountErrorMessage(
        new LogtoAccountError(
          'The social identity does not exist in the current user.',
          422,
          'user.identity_not_exists_in_current_user'
        ),
        { providerName: 'Lark', operation: 'reauthorize' }
      )
    ).toBe(
      'You authorized a different Lark account. Reconnect with the account already linked to this profile. To switch accounts, make sure another sign-in method is linked, then unlink Lark.'
    )
  })

  // Measured against a live tenant: a session opened before the deployment
  // granted the identities scope keeps working everywhere else, so "expired"
  // sends people to retry the same broken thing. Only a fresh sign-in helps.
  it('tells a scope-stale session to sign out rather than calling it expired', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')
    const unauthorized = new LogtoAccountError('unauthorized', 401)

    expect(accountErrorMessage(unauthorized, { providerName: 'Google', operation: 'link' })).toBe(
      'This sign-in session cannot change sign-in methods. Sign out, sign in again, and retry.'
    )
    // Outside linking a 401 really is a dead session.
    expect(accountErrorMessage(unauthorized)).toBe('Your sign-in session expired. Sign in again and retry.')
    expect(
      accountErrorMessage(new LogtoAccountError('forbidden', 403), {
        providerName: 'Lark',
        operation: 'reauthorize'
      })
    ).toBe('The Lark authorization could not be renewed. Return to Profile and try again.')
  })
})
