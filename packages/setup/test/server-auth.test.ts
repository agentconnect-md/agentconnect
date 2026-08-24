import { describe, expect, it } from 'vitest'
import { SetupAuthenticator, urlAtOrigin } from '../src/server/auth.js'

const oidc = { issuer: 'https://login.example.test/oidc', audience: 'agentconnect' }

describe('setup-server auth boundary', () => {
  it('accepts a verified ADMIN and rejects a valid non-admin identity', async () => {
    const config = { get: async () => oidc }
    const admin = new SetupAuthenticator(config, async () => ({ sub: 'admin-1', roles: ['USER', 'ADMIN'] }))
    await expect(admin.authenticate('Bearer token')).resolves.toEqual({ subject: 'admin-1' })

    const user = new SetupAuthenticator(config, async () => ({ sub: 'user-1', roles: ['admin'] }))
    await expect(user.authenticate('Bearer token')).rejects.toMatchObject({
      statusCode: 403,
      code: 'ADMIN_ROLE_REQUIRED'
    })
  })

  it('allows role-free identity verification only when the bootstrap flow requests it explicitly', async () => {
    const auth = new SetupAuthenticator({ get: async () => oidc }, async () => ({ sub: 'operator' }))
    await expect(auth.authenticate('Bearer token', false)).resolves.toEqual({ subject: 'operator' })
    await expect(auth.authenticate('Bearer token')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('does not fall back to unauthenticated access when OIDC is unavailable', async () => {
    const auth = new SetupAuthenticator({ get: async () => null }, async () => ({ sub: 'unused' }))
    await expect(auth.authenticate(undefined)).rejects.toMatchObject({
      statusCode: 503,
      code: 'ADMIN_OIDC_NOT_CONFIGURED'
    })
  })
})

describe('urlAtOrigin', () => {
  it('takes the target origin whole, including a port the value carried and the origin does not', () => {
    // Self-hosted Logto is reached in-cluster on :3001 and answers discovery with that port; the
    // browser-facing origin serves 443, and a surviving :3001 is a URL nothing answers on.
    expect(urlAtOrigin('http://logto.internal:3001/oidc/auth', 'https://auth.example.test').toString()).toBe(
      'https://auth.example.test/oidc/auth'
    )
    // The other direction still works: a target that names a port applies it.
    expect(urlAtOrigin('https://auth.example.test/oidc', 'http://logto.internal:3001').toString()).toBe(
      'http://logto.internal:3001/oidc'
    )
    // Neither side ported, and query/path survive.
    expect(urlAtOrigin('https://a.example.test/oidc/auth?x=1', 'https://b.example.test').toString()).toBe(
      'https://b.example.test/oidc/auth?x=1'
    )
  })
})
