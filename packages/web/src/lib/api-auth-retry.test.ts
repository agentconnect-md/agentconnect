import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  getToken: vi.fn(),
  getIdTokenRaw: vi.fn(),
  getUser: vi.fn(),
  refreshTokenAfterUnauthorized: vi.fn(),
  redirectExpiredSession: vi.fn(),
  signOutDeletedAccount: vi.fn()
}))

vi.mock('@/lib/auth', () => auth)

describe('Control Plane authentication recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    auth.getToken.mockReset().mockResolvedValueOnce('rejected-token').mockResolvedValue('fresh-token')
    auth.getIdTokenRaw.mockReset().mockResolvedValue(undefined)
    auth.getUser.mockReset().mockResolvedValue(null)
    auth.refreshTokenAfterUnauthorized.mockReset().mockResolvedValue('fresh-token')
    auth.redirectExpiredSession.mockReset().mockResolvedValue(undefined)
    auth.signOutDeletedAccount.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('forces a token refresh and retries a rejected GET once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ identities: [], hasSecurityVerificationMethod: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    vi.stubGlobal('fetch', fetchImpl)
    const { fetchMySocialAccount } = await import('./api')

    await expect(fetchMySocialAccount()).resolves.toEqual({
      identities: [],
      hasSecurityVerificationMethod: false
    })

    expect(auth.refreshTokenAfterUnauthorized).toHaveBeenCalledWith('rejected-token')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect((fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe(
      'Bearer rejected-token'
    )
    expect((fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer fresh-token')
    expect(auth.redirectExpiredSession).not.toHaveBeenCalled()
  })

  it('returns to sign-in when the refreshed token is rejected too', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
    )
    vi.stubGlobal('fetch', fetchImpl)
    const { fetchMySocialAccount } = await import('./api')

    await expect(fetchMySocialAccount()).rejects.toMatchObject({ status: 401 })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(auth.redirectExpiredSession).toHaveBeenCalledOnce()
  })

  it('does not refresh when the Control Plane says the account was deleted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 'ACCOUNT_GONE', message: 'account deleted' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        )
      )
    )
    const { fetchMySocialAccount } = await import('./api')

    await expect(fetchMySocialAccount()).rejects.toMatchObject({ status: 401, code: 'ACCOUNT_GONE' })

    expect(auth.refreshTokenAfterUnauthorized).not.toHaveBeenCalled()
    expect(auth.signOutDeletedAccount).toHaveBeenCalledOnce()
  })
})
