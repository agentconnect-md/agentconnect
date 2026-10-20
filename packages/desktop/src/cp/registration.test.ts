import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cpBaseUrl,
  defaultChannelUrl,
  exchangeRegistrationToken,
  loadRegistration,
  markRevoked,
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
    await expect(exchangeRegistrationToken('https://cp', 'tok', profile, fetchImpl)).rejects.toThrow(/spent or expired/)
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
})
