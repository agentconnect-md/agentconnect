import { BrowserStorage } from '@logto/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const replace = vi.fn()
const assign = vi.fn()
const storage = new BrowserStorage('web-app')
let grants: string[]
let rotation: number

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  }
}

beforeEach(async () => {
  vi.resetModules()
  replace.mockReset()
  assign.mockReset()
  grants = []
  rotation = 0
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('document', { cookie: '' })
  vi.stubGlobal('window', {
    __AC_ENV: {
      LOGTO_ENDPOINT: 'https://login.example.test',
      LOGTO_APP_ID: 'web-app',
      LOGTO_API_RESOURCE: 'https://api.example.test'
    },
    location: { origin: 'https://console.example.test', pathname: '/example/agents', search: '', replace, assign }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: 'https://login.example.test/oidc',
          authorization_endpoint: 'https://login.example.test/oidc/auth',
          token_endpoint: 'https://login.example.test/oidc/token',
          revocation_endpoint: 'https://login.example.test/oidc/revoke',
          end_session_endpoint: 'https://login.example.test/oidc/session/end',
          jwks_uri: 'https://login.example.test/oidc/jwks'
        })
      }
      if (String(input).endsWith('/revoke')) return new Response(null, { status: 200 })
      const params = new URLSearchParams(String(init?.body))
      const refreshToken = params.get('refresh_token')!
      grants.push(refreshToken)
      if (refreshToken !== `refresh-${rotation}`) {
        return Response.json({ code: 'oidc.invalid_grant', message: 'refresh token already used' }, { status: 400 })
      }
      rotation++
      // Let another caller reach the token endpoint before this rotation reaches storage.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return Response.json({
        access_token: `access-${rotation}`,
        refresh_token: `refresh-${rotation}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid'
      })
    })
  )
  await storage.setItem('idToken', 'example-id-token')
  await storage.setItem('refreshToken', 'refresh-0')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['idToken', 'refreshToken'] as const)('redirects when shared storage loses its %s', async (key) => {
  const { getToken } = await import('./auth')
  await storage.removeItem(key)

  await expect(getToken()).rejects.toMatchObject({ code: 'not_authenticated' })

  expect(replace).toHaveBeenCalledWith('/login')
  expect(sessionStorage.getItem('ac.returnTo')).toBe('/example/agents')
  expect(grants).toEqual([])
})

it.each([true, false])('serializes token audiences with Web Locks available: %s', async (webLocks) => {
  if (!webLocks) vi.stubGlobal('navigator', { locks: undefined })
  const { getToken, getAccountToken } = await import('./auth')

  await expect(Promise.all([getToken(), getAccountToken()])).resolves.toEqual(['access-1', 'access-2'])

  expect(grants).toEqual(['refresh-0', 'refresh-1'])
  expect(replace).not.toHaveBeenCalled()
})

it('finishes an in-flight refresh before signing out and leaves SSO navigation intact', async () => {
  const { getToken, logout } = await import('./auth')

  await Promise.all([getToken(), logout()])
  await expect(getToken()).rejects.toMatchObject({ code: 'not_authenticated' })

  expect(await storage.getItem('refreshToken')).toBeNull()
  expect(await storage.getItem('idToken')).toBeNull()
  expect(assign).toHaveBeenCalledOnce()
  expect(replace).not.toHaveBeenCalled()
})

it('keeps token reads optional when authentication is not configured', async () => {
  window.__AC_ENV = {}
  const { getToken } = await import('./auth')

  await expect(getToken()).resolves.toBeUndefined()
  expect(replace).not.toHaveBeenCalled()
  expect(grants).toEqual([])
})

it('releases the session lock after a timed-out token request so another caller can recover', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(20))
  const respond = vi.mocked(fetch).getMockImplementation()!
  let stalled = false
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith('/token') && !stalled) {
      stalled = true
      return new Promise((_, reject) => {
        const signal = init!.signal!
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    return respond(input, init)
  })
  const { getToken } = await import('./auth')

  const results = await Promise.allSettled([getToken(), getToken()])

  expect(results[0]).toMatchObject({ status: 'rejected', reason: { name: 'TimeoutError' } })
  expect(results[1]).toEqual({ status: 'fulfilled', value: 'access-1' })
  expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000)
  expect(replace).not.toHaveBeenCalled()
})

it('shares refreshed tokens across independent page instances, including concurrent 401 recovery', async () => {
  const firstPage = await import('./auth')
  vi.resetModules()
  const secondPage = await import('./auth')

  await expect(Promise.all([firstPage.getToken(), secondPage.getToken()])).resolves.toEqual(['access-1', 'access-1'])
  await expect(
    Promise.all([
      firstPage.refreshTokenAfterUnauthorized('access-1'),
      secondPage.refreshTokenAfterUnauthorized('access-1')
    ])
  ).resolves.toEqual(['access-2', 'access-2'])
  await expect(firstPage.getToken()).resolves.toBe('access-2')

  expect(grants).toEqual(['refresh-0', 'refresh-1'])
  expect(replace).not.toHaveBeenCalled()
})
