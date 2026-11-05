import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logto = vi.hoisted(() => ({
  signIn: vi.fn(),
  handleSignInCallback: vi.fn(),
  isAuthenticated: vi.fn(),
  getAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
  clearAllTokens: vi.fn(),
  setJwtVerifier: vi.fn(),
  replace: vi.fn(),
  clientConfig: undefined as unknown
}))

vi.mock('@logto/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@logto/browser')>()),
  default: class MockLogtoClient {
    constructor(config: unknown) {
      logto.clientConfig = config
    }
    isAuthenticated = logto.isAuthenticated
    signIn = logto.signIn
    handleSignInCallback = logto.handleSignInCallback
    getAccessToken = logto.getAccessToken
    clearAccessToken = logto.clearAccessToken
    clearAllTokens = logto.clearAllTokens
    setJwtVerifier = logto.setJwtVerifier
  },
  Prompt: { Login: 'login', Consent: 'consent' },
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

describe('console authentication', () => {
  beforeEach(() => {
    vi.resetModules()
    logto.signIn.mockReset().mockResolvedValue(undefined)
    logto.handleSignInCallback.mockReset().mockResolvedValue(undefined)
    logto.isAuthenticated.mockReset().mockResolvedValue(true)
    logto.getAccessToken.mockReset()
    logto.clearAccessToken.mockReset().mockResolvedValue(undefined)
    logto.clearAllTokens.mockReset().mockResolvedValue(undefined)
    logto.setJwtVerifier.mockReset()
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
        pathname: '/agents',
        search: '',
        replace: logto.replace
      }
    })
    vi.stubGlobal('document', { cookie: '' })
    const session = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key)
    })
  })

  function visit(pathname: string, search = ''): void {
    Object.assign(window.location, { pathname, search, href: `https://console.example.test${pathname}${search}` })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('authenticates the selected provider even with an existing SSO session and keeps offline consent', async () => {
    const { login } = await import('./auth')

    await login('gitlab')

    expect(logto.signIn).toHaveBeenCalledWith({
      redirectUri: 'https://console.example.test/auth/callback',
      directSignIn: { method: 'social', target: 'gitlab' },
      prompt: ['login', 'consent']
    })
  })

  it('goes straight to the SSO connector', async () => {
    const { loginWithSso } = await import('./auth')

    await loginWithSso('sso-connector')

    expect(logto.signIn).toHaveBeenCalledWith({
      redirectUri: 'https://console.example.test/auth/callback',
      directSignIn: { method: 'sso', target: 'sso-connector' },
      prompt: ['login', 'consent']
    })
  })

  it('allows normal SSO when no provider was selected', async () => {
    const { login } = await import('./auth')

    await login()

    expect(logto.signIn).toHaveBeenCalledWith({ redirectUri: 'https://console.example.test/auth/callback' })
  })

  it('exchanges the authorization code once across repeated callback effects', async () => {
    visit('/auth/callback', '?code=example-code&state=example-state')
    const { completeLogin } = await import('./auth')

    await Promise.all([completeLogin(), completeLogin()])
    await completeLogin()

    expect(logto.handleSignInCallback).toHaveBeenCalledOnce()
    expect(logto.handleSignInCallback).toHaveBeenCalledWith(window.location.href)
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

  it('returns to the page the session expired on, such as an OAuth consent request', async () => {
    visit('/oauth/consent', '?client_id=c1&redirect_uri=https%3A%2F%2Fconsole.example.test%2Fcb&state=s1')
    logto.getAccessToken.mockRejectedValue(requestError('oidc.invalid_grant'))
    const { getToken } = await import('./auth')

    await getToken().catch(() => undefined)

    expect(sessionStorage.getItem('ac.returnTo')).toBe(
      '/oauth/consent?client_id=c1&redirect_uri=https%3A%2F%2Fconsole.example.test%2Fcb&state=s1'
    )
    expect(logto.replace).toHaveBeenCalledWith('/login')
  })

  it.each(['/login', '/auth/callback'])('keeps no return path from the sign-in page %s', async (pathname) => {
    visit(pathname, '?code=abc')
    logto.getAccessToken.mockRejectedValue(requestError('oidc.invalid_grant'))
    const { getToken } = await import('./auth')

    await getToken().catch(() => undefined)

    expect(sessionStorage.getItem('ac.returnTo')).toBeNull()
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
    expect(logto.setJwtVerifier).toHaveBeenCalledOnce()
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
