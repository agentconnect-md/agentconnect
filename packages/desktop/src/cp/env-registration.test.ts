import { describe, expect, it } from 'vitest'
import { keepsRegistration, registrationFromEnv } from './env-registration.js'
import type { Registration } from './registration.js'

const registration: Registration = {
  cpUrl: 'https://cp.example.com',
  channelUrl: 'wss://cp.example.com/v1/computers/ws',
  computerId: '00000000-0000-4000-8000-000000000001',
  orgId: 'org_1',
  apiKeyId: 'key_1',
  apiKey: 'secret',
  registeredAt: '2026-10-01T00:00:00.000Z'
}

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

  it('keeps a live key for the same CP and registers again after a revoke or for another CP', () => {
    expect(keepsRegistration(registration, 'https://cp.example.com/')).toBe(true)
    expect(keepsRegistration(registration, 'https://cp.example.com/v1/computers/register')).toBe(true)
    expect(keepsRegistration(undefined, 'https://cp.example.com')).toBe(false)
    expect(
      keepsRegistration({ ...registration, revokedAt: '2026-10-02T00:00:00.000Z' }, 'https://cp.example.com')
    ).toBe(false)
    expect(keepsRegistration(registration, 'https://other.example.com')).toBe(false)
  })
})
