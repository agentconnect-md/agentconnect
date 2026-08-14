import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logto = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  getAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
  clearAllTokens: vi.fn(),
  replace: vi.fn(),
  clientConfig: undefined as unknown
}))

vi.mock('@logto/browser', () => ({
  default: class MockLogtoClient {
    constructor(config: unknown) {
      logto.clientConfig = config
    }
    isAuthenticated = logto.isAuthenticated
    getAccessToken = logto.getAccessToken
    clearAccessToken = logto.clearAccessToken
    clearAllTokens = logto.clearAllTokens
  },
  UserScope: {
    Email: 'email',
    Profile: 'profile',
    Identities: 'identities',
    Roles: 'roles'
  },
  isLogtoRequestError: (error: unknown) => error instanceof Error && error.name === 'LogtoRequestError'
}))

function requestError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { name: 'LogtoRequestError', code })
}

describe('getToken', () => {
  beforeEach(() => {
    vi.resetModules()
    logto.isAuthenticated.mockReset().mockResolvedValue(true)
    logto.getAccessToken.mockReset()
    logto.clearAccessToken.mockReset().mockResolvedValue(undefined)
    logto.clearAllTokens.mockReset().mockResolvedValue(undefined)
    logto.replace.mockReset()
    logto.clientConfig = undefined
    vi.stubGlobal('window', {
      __AC_ENV: {
        LOGTO_ENDPOINT: 'https://login.example.test',
        LOGTO_APP_ID: 'web-app',
        LOGTO_API_RESOURCE: 'https://api.example.test'
      },
      location: {
        href: 'https://console.example.test/agents',
        origin: 'https://console.example.test',
        replace: logto.replace
      }
    })
    vi.stubGlobal('document', { cookie: '' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('clears the local session and silently redirects when the refresh grant is invalid', async () => {
    const error = requestError('oidc.invalid_grant')
    logto.getAccessToken.mockRejectedValue(error)
    const { getToken } = await import('./auth')

    await expect(getToken()).rejects.toBe(error)

    expect(logto.clearAllTokens).toHaveBeenCalledOnce()
    expect(document.cookie).toBe('ac.org=; path=/; max-age=0')
    expect(logto.replace).toHaveBeenCalledOnce()
    expect(logto.replace).toHaveBeenCalledWith('/login')
  })

  it('does not turn other token failures into a login redirect', async () => {
    const error = requestError('oidc.temporarily_unavailable')
    logto.getAccessToken.mockRejectedValue(error)
    const { getToken } = await import('./auth')

    await expect(getToken()).rejects.toBe(error)

    expect(logto.clearAllTokens).not.toHaveBeenCalled()
    expect(logto.replace).not.toHaveBeenCalled()
  })

  it('performs invalid-grant cleanup once when requests fail concurrently', async () => {
    const error = requestError('oidc.invalid_grant')
    logto.getAccessToken.mockRejectedValue(error)
    const { getToken } = await import('./auth')

    const results = await Promise.allSettled([getToken(), getToken()])

    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(logto.clearAllTokens).toHaveBeenCalledOnce()
    expect(logto.replace).toHaveBeenCalledOnce()
  })

  it('mints a resource-less token with the identities scope for the Account API', async () => {
    logto.getAccessToken.mockResolvedValue('opaque-account-token')
    const { getAccountToken } = await import('./auth')

    await expect(getAccountToken()).resolves.toBe('opaque-account-token')

    expect(logto.getAccessToken).toHaveBeenCalledWith()
    expect(logto.clientConfig).toMatchObject({ scopes: ['email', 'profile', 'identities', 'roles'] })
  })

  it('forces a fresh resource token after the Control Plane rejects the cached one', async () => {
    logto.getAccessToken.mockResolvedValueOnce('rejected-token').mockResolvedValueOnce('fresh-token')
    const { refreshTokenAfterUnauthorized } = await import('./auth')

    await expect(refreshTokenAfterUnauthorized('rejected-token')).resolves.toBe('fresh-token')

    expect(logto.clearAccessToken).toHaveBeenCalledOnce()
    expect(logto.getAccessToken).toHaveBeenNthCalledWith(1, 'https://api.example.test')
    expect(logto.getAccessToken).toHaveBeenNthCalledWith(2, 'https://api.example.test')
  })

  it('uses the resource-less audience when the Account API rejects its token', async () => {
    logto.getAccessToken.mockResolvedValueOnce('rejected-account-token').mockResolvedValueOnce('fresh-account-token')
    const { refreshTokenAfterUnauthorized } = await import('./auth')

    await expect(refreshTokenAfterUnauthorized('rejected-account-token', 'account')).resolves.toBe(
      'fresh-account-token'
    )

    expect(logto.getAccessToken).toHaveBeenNthCalledWith(1)
    expect(logto.getAccessToken).toHaveBeenNthCalledWith(2)
  })
})
