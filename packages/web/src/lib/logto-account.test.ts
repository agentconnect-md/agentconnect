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

  it('loads enabled connectors dynamically and joins them to the current identities', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/my-account')) {
        return new Response(
          JSON.stringify({
            primaryEmail: 'person@example.test',
            hasSecurityVerificationMethod: true,
            identities: {
              github: {
                userId: 'github-user',
                details: { name: 'Octo Cat', email: 'octo@example.test' }
              }
            }
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          socialConnectors: [
            {
              id: 'github-connector',
              target: 'github',
              name: { en: 'GitHub' },
              logo: 'data:image/svg+xml,github'
            },
            {
              id: 'google-connector',
              target: 'google',
              name: { en: 'Google' },
              logo: 'data:image/svg+xml,google'
            }
          ]
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchSignInMethods } = await import('./logto-account')
    const result = await fetchSignInMethods()

    expect(result.account.primaryEmail).toBe('person@example.test')
    expect(result.account.identities.github?.details).toEqual({
      name: 'Octo Cat',
      email: 'octo@example.test'
    })
    expect(result.connectors.map(({ id, target, name }) => ({ id, target, name }))).toEqual([
      { id: 'github-connector', target: 'github', name: 'GitHub' },
      { id: 'google-connector', target: 'google', name: 'Google' }
    ])
    const accountCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/api/my-account'))
    expect(new Headers(accountCall?.[1]?.headers).get('authorization')).toBe('Bearer opaque-account-token')
    const connectorsCall = fetchMock.mock.calls.find(([input]) => String(input).includes('social-connectors'))
    expect(String(connectorsCall?.[0])).toBe('/api/logto/social-connectors')
  })

  it('creates and verifies a current-user email verification record', async () => {
    const requests: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        requests.push(init ?? {})
        return new Response(
          JSON.stringify({
            verificationRecordId: requests.length === 1 ? 'pending-verification' : 'verified-user'
          }),
          { status: requests.length === 1 ? 201 : 200 }
        )
      })
    )

    const { requestEmailVerification, verifyEmailCode } = await import('./logto-account')
    await expect(requestEmailVerification('person@example.test')).resolves.toBe('pending-verification')
    await expect(verifyEmailCode('person@example.test', 'pending-verification', '123456')).resolves.toBe(
      'verified-user'
    )

    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      identifier: { type: 'email', value: 'person@example.test' },
      templateType: 'UserPermissionValidation'
    })
    expect(JSON.parse(String(requests[1]?.body))).toEqual({
      identifier: { type: 'email', value: 'person@example.test' },
      verificationId: 'pending-verification',
      code: '123456'
    })
  })

  it('explains identity conflicts without offering account merging', async () => {
    const { LogtoAccountError, accountErrorMessage } = await import('./logto-account')

    expect(
      accountErrorMessage(new LogtoAccountError('identity already used', 422, 'user.identity_already_in_use'), {
        providerName: 'Google',
        linking: true
      })
    ).toBe('That Google account is already connected to another AgentConnect account.')
  })
})
