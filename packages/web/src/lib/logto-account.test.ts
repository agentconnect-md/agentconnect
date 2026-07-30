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

  it('explains identity conflicts without offering account merging', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')

    expect(
      accountErrorMessage(new LogtoAccountError('identity already linked', 409, 'SOCIAL_IDENTITY_IN_USE'), {
        providerName: 'Google',
        linking: true
      })
    ).toBe('That Google account is already linked to another AgentConnect account.')
  })
})
