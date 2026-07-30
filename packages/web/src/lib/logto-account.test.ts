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

  it('loads current identities without fetching the static provider list', async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          identities: {
            github: {
              userId: 'github-user',
              details: { name: 'Octo Cat', email: 'octo@example.test' }
            }
          }
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchAccountProfile } = await import('./logto-account')
    const { SOCIAL_LOGIN_PROVIDERS } = await import('./social-login-providers')
    const account = await fetchAccountProfile()

    expect(account.identities.github?.details).toEqual({
      name: 'Octo Cat',
      email: 'octo@example.test'
    })
    expect(SOCIAL_LOGIN_PROVIDERS).toEqual([
      { target: 'github', name: 'GitHub' },
      { target: 'google', name: 'Google' },
      { target: 'slack', name: 'Slack' }
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://login.example.test/api/my-account')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer opaque-account-token')
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
    ).toBe('That Google account is already connected to another AgentConnect account.')
  })
})
