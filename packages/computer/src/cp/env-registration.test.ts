import { describe, expect, it, vi } from 'vitest'
import {
  keepsRegistration,
  registerFromEnv,
  registrationFromEnv,
  staysRevoked,
  tokenSha256,
  type EnvRegistration
} from './env-registration.js'
import { RegistrationTokenRefused, type Registration } from './registration.js'

const registration: Registration = {
  cpUrl: 'https://cp.example.com',
  channelUrl: 'wss://cp.example.com/v1/computers/ws',
  computerId: '00000000-0000-4000-8000-000000000001',
  orgId: 'org_1',
  apiKeyId: 'key_1',
  apiKey: 'secret',
  registeredAt: '2026-10-01T00:00:00.000Z',
  tokenSha256: tokenSha256('acr_spent')
}
const spent: EnvRegistration = { token: 'acr_spent', cpUrl: 'https://cp.example.com' }

describe('registration from the environment', () => {
  it('takes the token from the variable, else the secret file, with the CP URL and an optional name', () => {
    expect(registrationFromEnv({})).toBeUndefined()
    expect(
      registrationFromEnv({
        AGENTCONNECT_REGISTER_TOKEN: ' tok \n',
        AGENTCONNECT_CP_URL: 'https://cp.example.com',
        AGENTCONNECT_COMPUTER_NAME: 'browser-1'
      })
    ).toEqual({ token: 'tok', cpUrl: 'https://cp.example.com', name: 'browser-1' })
    const read = (path: string) => (path === '/run/secrets/token' ? 'from-file\n' : '')
    expect(
      registrationFromEnv(
        { AGENTCONNECT_REGISTER_TOKEN_FILE: '/run/secrets/token', AGENTCONNECT_CP_URL: 'https://cp.example.com' },
        read
      )
    ).toEqual({ token: 'from-file', cpUrl: 'https://cp.example.com' })
  })

  it('never puts the token in an error', () => {
    expect(() => registrationFromEnv({ AGENTCONNECT_REGISTER_TOKEN: 'acr_secret' })).toThrow(/AGENTCONNECT_CP_URL/)
    try {
      registrationFromEnv({ AGENTCONNECT_REGISTER_TOKEN: 'acr_secret' })
    } catch (error) {
      expect((error as Error).message).not.toContain('acr_secret')
    }
    const missing = () => {
      throw Object.assign(new Error('ENOENT: acr_secret'), { code: 'ENOENT' })
    }
    expect(() =>
      registrationFromEnv({ AGENTCONNECT_REGISTER_TOKEN_FILE: '/nope', AGENTCONNECT_CP_URL: 'https://cp' }, missing)
    ).toThrow('cannot read AGENTCONNECT_REGISTER_TOKEN_FILE (/nope): ENOENT')
  })

  it('keeps a live key only for the same CP and the token it was spent from', () => {
    expect(keepsRegistration(registration, { ...spent, cpUrl: 'https://cp.example.com/' })).toBe(true)
    expect(keepsRegistration(registration, { ...spent, cpUrl: 'https://cp.example.com/v1/computers/register' })).toBe(
      true
    )
    expect(keepsRegistration(undefined, spent)).toBe(false)
    expect(keepsRegistration({ ...registration, revokedAt: '2026-10-02T00:00:00.000Z' }, spent)).toBe(false)
    expect(keepsRegistration(registration, { ...spent, cpUrl: 'https://other.example.com' })).toBe(false)
    expect(keepsRegistration(registration, { ...spent, token: 'acr_new' })).toBe(false)
    const { tokenSha256: _, ...unhashed } = registration
    expect(keepsRegistration(unhashed, spent)).toBe(false)
  })

  it('stays up on a refused token only when the stored key is revoked and belongs to the same CP', () => {
    const revoked = { ...registration, revokedAt: '2026-10-02T00:00:00.000Z' }
    expect(staysRevoked(revoked, 'https://cp.example.com/')).toBe(true)
    expect(staysRevoked(revoked, 'https://other.example.com')).toBe(false)
    expect(staysRevoked(registration, 'https://other.example.com')).toBe(false)
    expect(staysRevoked(registration, 'https://cp.example.com')).toBe(false)
    expect(staysRevoked(undefined, 'https://cp.example.com')).toBe(false)
  })
})

describe('registerFromEnv', () => {
  const fresh: Registration = { ...registration, computerId: '00000000-0000-4000-8000-000000000002', apiKey: 'new' }
  const decide = (
    wanted: EnvRegistration | undefined,
    current: Registration | undefined,
    exchange: () => Promise<Registration>
  ) => {
    const save = vi.fn()
    const exchangeSpy = vi.fn(exchange)
    return {
      save,
      exchange: exchangeSpy,
      outcome: registerFromEnv({ wanted, load: () => current, exchange: exchangeSpy, save })
    }
  }
  const refused = () => Promise.reject(new RegistrationTokenRefused())

  it('does nothing without a token', async () => {
    const run = decide(undefined, registration, refused)
    await expect(run.outcome).resolves.toEqual({ kind: 'none' })
    expect(run.exchange).not.toHaveBeenCalled()
  })

  it('keeps a live key for the same CP spent from the same token without spending it again', async () => {
    const run = decide(spent, registration, refused)
    await expect(run.outcome).resolves.toEqual({ kind: 'kept', registration })
    expect(run.exchange).not.toHaveBeenCalled()
    expect(run.save).not.toHaveBeenCalled()
  })

  it('spends a new token over a live key and stores its hash', async () => {
    const wanted = { ...spent, token: 'acr_new' }
    const run = decide(wanted, registration, async () => ({ ...fresh, tokenSha256: undefined }))
    const outcome = await run.outcome
    expect(outcome.kind).toBe('registered')
    expect(run.save).toHaveBeenCalledWith({ ...fresh, tokenSha256: tokenSha256('acr_new') })
    expect(JSON.stringify(run.save.mock.calls)).not.toContain('acr_new')
  })

  it('registers a live key for another CP again, and fails when that token is refused', async () => {
    const other = { ...spent, cpUrl: 'https://other.example.com' }
    const ok = decide(other, registration, async () => fresh)
    await expect(ok.outcome).resolves.toMatchObject({ kind: 'registered' })
    await expect(decide(other, registration, refused).outcome).rejects.toBeInstanceOf(RegistrationTokenRefused)
  })

  it('stays revoked when the spent token is refused for a revoked key on the same CP', async () => {
    const revoked = { ...registration, revokedAt: '2026-10-02T00:00:00.000Z', apiKey: 'revoked' }
    const run = decide(spent, revoked, refused)
    await expect(run.outcome).resolves.toMatchObject({ kind: 'stays-revoked', registration: revoked })
    expect(run.save).not.toHaveBeenCalled()
  })

  it('rethrows a transient error instead of keeping a revoked key', async () => {
    const revoked = { ...registration, revokedAt: '2026-10-02T00:00:00.000Z' }
    const run = decide(spent, revoked, () => Promise.reject(new Error('registration failed: HTTP 503')))
    await expect(run.outcome).rejects.toThrow('HTTP 503')
  })

  it('fails on a refused token with no stored key', async () => {
    await expect(decide(spent, undefined, refused).outcome).rejects.toBeInstanceOf(RegistrationTokenRefused)
  })
})
