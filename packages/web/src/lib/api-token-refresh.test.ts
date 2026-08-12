import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  getToken: vi.fn(),
  forceRefreshToken: vi.fn(),
  getIdTokenRaw: vi.fn(),
  getUser: vi.fn(),
  signOutDeletedAccount: vi.fn()
}))

vi.mock('@/lib/auth', () => auth)

import { getMyAccess } from './api'

describe('Control Plane token expiry recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('evicts the stale token and retries once when the CP marks it expired', async () => {
    auth.getToken.mockResolvedValueOnce('stale-token').mockResolvedValue('fresh-token')
    auth.forceRefreshToken.mockResolvedValue('fresh-token')
    auth.getIdTokenRaw.mockResolvedValue(undefined)
    auth.getUser.mockResolvedValue(null)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'TOKEN_EXPIRED', message: 'access token expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ waitlistMode: false, status: 'active', activated: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMyAccess()).resolves.toMatchObject({ status: 'active' })

    expect(auth.forceRefreshToken).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer stale-token')
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer fresh-token')
  })

  it('does not retry an unrelated unauthorized response', async () => {
    auth.getToken.mockResolvedValue('token')
    auth.getIdTokenRaw.mockResolvedValue(undefined)
    auth.getUser.mockResolvedValue(null)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getMyAccess()).rejects.toMatchObject({ status: 401 })

    expect(auth.forceRefreshToken).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
