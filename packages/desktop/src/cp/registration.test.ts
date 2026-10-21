import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cpBaseUrl,
  defaultChannelUrl,
  exchangeRegistrationToken,
  loadRegistration,
  markRevoked,
  registerOrKeep,
  RegistrationTokenRefused,
  registrationPath,
  saveRegistration
} from './registration.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'acd-reg-'))
  dirs.push(dir)
  return dir
}

const profile = {
  name: 'desk',
  isolation: 'none' as const,
  os: 'linux' as const,
  osVersion: 'Ubuntu 26.04',
  session: 'x11' as const,
  desktopDaemonVersion: '0.2.0',
  driverVersion: '0.35.2'
}

describe('registration', () => {
  it('accepts the bare origin, a trailing slash or the exchange URL the console prints', () => {
    expect(cpBaseUrl('https://cp.example.com/')).toBe('https://cp.example.com')
    expect(cpBaseUrl('https://cp.example.com/v1/computers/register')).toBe('https://cp.example.com')
    expect(defaultChannelUrl('http://localhost:8080')).toBe('ws://localhost:8080/v1/computers/ws')
  })

  it('spends the token at the exchange and keeps the channel URL the CP names', async () => {
    const requests: { url: string; body: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(
        JSON.stringify({
          computerId: '00000000-0000-4000-8000-000000000001',
          orgId: 'org_1',
          apiKeyId: 'key_1',
          apiKey: 'secret',
          displayTail: '…cret',
          channelUrl: 'wss://cp.example.com/v1/computers/ws'
        }),
        { status: 201 }
      )
    }) as unknown as typeof fetch
    const registration = await exchangeRegistrationToken(
      'https://cp.example.com/v1/computers/register',
      'tok',
      profile,
      fetchImpl
    )
    expect(requests[0]).toEqual({
      url: 'https://cp.example.com/v1/computers/register',
      body: { token: 'tok', ...profile }
    })
    expect(registration).toMatchObject({
      cpUrl: 'https://cp.example.com',
      channelUrl: 'wss://cp.example.com/v1/computers/ws',
      apiKey: 'secret'
    })
  })

  it('names a spent or expired token plainly', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const refused = exchangeRegistrationToken('https://cp', 'tok', profile, fetchImpl)
    await expect(refused).rejects.toThrow(/spent or expired/)
    // setup tells a refused token apart from an unreachable CP, so re-running the install keeps a good key.
    await expect(refused).rejects.toBeInstanceOf(RegistrationTokenRefused)
    const down = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch
    await expect(exchangeRegistrationToken('https://cp', 'tok', profile, down)).rejects.not.toBeInstanceOf(
      RegistrationTokenRefused
    )
  })

  it.skipIf(process.platform === 'win32')('stores the key owner-only and forgets it at a revoke', () => {
    const dir = tempDir()
    saveRegistration(
      {
        cpUrl: 'https://cp.example.com',
        channelUrl: 'wss://cp.example.com/v1/computers/ws',
        computerId: '00000000-0000-4000-8000-000000000001',
        orgId: 'org_1',
        apiKeyId: 'key_1',
        apiKey: 'secret',
        registeredAt: new Date().toISOString()
      },
      dir
    )
    expect(statSync(registrationPath(dir)).mode & 0o777).toBe(0o600)
    markRevoked(dir, 'revoked by the Control Plane')
    const after = loadRegistration(dir)!
    expect(after.apiKey).not.toBe('secret')
    expect(after.revokedReason).toBe('revoked by the Control Plane')
    expect(statSync(registrationPath(dir)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('never writes the key into a wider leftover tmp file or data dir', () => {
    const dir = tempDir()
    chmodSync(dir, 0o755)
    writeFileSync(`${registrationPath(dir)}.tmp`, 'stale', { mode: 0o644 })
    saveRegistration(
      {
        cpUrl: 'https://cp.example.com',
        channelUrl: 'wss://cp.example.com/v1/computers/ws',
        computerId: '00000000-0000-4000-8000-000000000001',
        orgId: 'org_1',
        apiKeyId: 'key_1',
        apiKey: 'secret',
        registeredAt: new Date().toISOString()
      },
      dir
    )
    expect(statSync(registrationPath(dir)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(existsSync(`${registrationPath(dir)}.tmp`)).toBe(false)
    expect(loadRegistration(dir)?.apiKey).toBe('secret')
  })
})

describe('registerOrKeep', () => {
  const stored = {
    cpUrl: 'https://cp.example.com',
    channelUrl: 'wss://cp.example.com/v1/computers/ws',
    computerId: '00000000-0000-4000-8000-000000000001',
    orgId: 'org_1',
    apiKeyId: 'key_1',
    apiKey: 'secret',
    registeredAt: new Date().toISOString()
  }
  const refused = async (): Promise<never> => {
    throw new RegistrationTokenRefused()
  }
  const withStored = (extra: Record<string, string> = {}): string => {
    const dir = tempDir()
    saveRegistration({ ...stored, ...extra }, dir)
    return dir
  }

  it('registers when the token is good', async () => {
    const fresh = { ...stored, computerId: '00000000-0000-4000-8000-000000000002' }
    expect(await registerOrKeep(withStored(), 'https://cp.example.com', async () => fresh)).toEqual({
      registration: fresh,
      kept: false
    })
  })

  it('keeps a matching, unrevoked registration when the token is spent', async () => {
    const result = await registerOrKeep(withStored(), 'https://cp.example.com/', refused)
    expect(result).toMatchObject({ kept: true, registration: { computerId: stored.computerId } })
  })

  it('rethrows a spent token when the stored registration is revoked', async () => {
    const dir = withStored({ revokedAt: new Date().toISOString() })
    await expect(registerOrKeep(dir, 'https://cp.example.com', refused)).rejects.toBeInstanceOf(
      RegistrationTokenRefused
    )
  })

  it('rethrows a spent token for a different Control Plane', async () => {
    await expect(registerOrKeep(withStored(), 'https://other.example.com', refused)).rejects.toBeInstanceOf(
      RegistrationTokenRefused
    )
  })

  it('rethrows a spent token with nothing stored', async () => {
    await expect(registerOrKeep(tempDir(), 'https://cp.example.com', refused)).rejects.toBeInstanceOf(
      RegistrationTokenRefused
    )
  })

  it('rethrows a server or network failure even with a matching registration', async () => {
    const down = async (): Promise<never> => {
      throw new Error('registration failed: HTTP 502 bad gateway')
    }
    await expect(registerOrKeep(withStored(), 'https://cp.example.com', down)).rejects.toThrow(/HTTP 502/)
    const offline = async (): Promise<never> => {
      throw new TypeError('fetch failed')
    }
    await expect(registerOrKeep(withStored(), 'https://cp.example.com', offline)).rejects.toThrow('fetch failed')
  })
})
