import { describe, it, expect, vi } from 'vitest'
import { RelayAuthService } from './relayAuthService.js'
import { ApiKeyCodec } from './apiKey.js'
import type { ApiKeyRepo, ApiKeyRecord } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { DaemonId } from '../domain/ids.js'

const PEPPER = 'unit-test-pepper-0123456789abcdefghij'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })
const NOW = 1_700_000_000_000
const clock = { now: () => NOW } as unknown as Clock
const RELAY_TOKEN = 'r'.repeat(48) // ≥32, dot-free

function relayRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'relay_key_1',
    principalType: 'relay',
    orgId: null,
    daemonId: null,
    userId: null,
    oauthGrantId: null,
    displayTail: '…abcd',
    name: 'pod-0',
    scopes: [],
    createdAt: new Date(NOW),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over
  }
}

function repo(row: ApiKeyRecord | null): ApiKeyRepo {
  return {
    findByHash: vi.fn(async () => row),
    touchLastUsed: vi.fn(async () => {})
  } as unknown as ApiKeyRepo
}

function service(row: ApiKeyRecord | null, opts: { RELAY_TOKEN?: string } = {}): RelayAuthService {
  return new RelayAuthService(codec, repo(row), clock, { ...opts, HEARTBEAT_SEC: 15 })
}

describe('RelayAuthService — token mode', () => {
  it('accepts the exact shared secret', async () => {
    const r = await service(null, { RELAY_TOKEN }).authenticate({ method: 'token', credential: RELAY_TOKEN })
    expect(r).toEqual({ ok: true, identity: 'shared-token' })
  })

  it('rejects a wrong secret', async () => {
    const r = await service(null, { RELAY_TOKEN }).authenticate({ method: 'token', credential: 'x'.repeat(48) })
    expect(r.ok).toBe(false)
  })

  it('rejects a secret of a different length (no timingSafeEqual crash)', async () => {
    const r = await service(null, { RELAY_TOKEN }).authenticate({ method: 'token', credential: 'short' })
    expect(r.ok).toBe(false)
  })

  it('is OFF when RELAY_TOKEN is unset — every token is rejected', async () => {
    const r = await service(null, {}).authenticate({ method: 'token', credential: RELAY_TOKEN })
    expect(r).toMatchObject({ ok: false, reason: 'token auth not configured' })
  })

  it('advertises the configured heartbeat cadence', () => {
    expect(service(null, { RELAY_TOKEN }).heartbeatSec).toBe(15)
  })
})

describe('RelayAuthService — apikey mode', () => {
  it('accepts a live relay key and touches lastUsed', async () => {
    const { token } = codec.mint()
    const svc = service(relayRecord())
    const r = await svc.authenticate({ method: 'apikey', credential: token })
    expect(r).toEqual({ ok: true, identity: 'relay_key_1' })
  })

  it('rejects a daemon/user key presented as a relay credential', async () => {
    const { token } = codec.mint()
    expect(
      (await service(relayRecord({ principalType: 'daemon' })).authenticate({ method: 'apikey', credential: token })).ok
    ).toBe(false)
    expect(
      (await service(relayRecord({ principalType: 'user' })).authenticate({ method: 'apikey', credential: token })).ok
    ).toBe(false)
  })

  it('rejects revoked / expired / unknown / malformed keys', async () => {
    const { token } = codec.mint()
    expect(
      (
        await service(relayRecord({ revokedAt: new Date(NOW - 1) })).authenticate({
          method: 'apikey',
          credential: token
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await service(relayRecord({ expiresAt: new Date(NOW - 1) })).authenticate({
          method: 'apikey',
          credential: token
        })
      ).ok
    ).toBe(false)
    expect((await service(null).authenticate({ method: 'apikey', credential: token })).ok).toBe(false)
    expect((await service(relayRecord()).authenticate({ method: 'apikey', credential: 'not-a-key' })).ok).toBe(false)
  })
})

function daemonRecord(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return relayRecord({
    id: 'daemon_key_1',
    principalType: 'daemon',
    orgId: 'org-1' as unknown as ApiKeyRecord['orgId'],
    daemonId: 'daemon-1' as unknown as ApiKeyRecord['daemonId'],
    ...over
  })
}

describe('RelayAuthService.verifyDaemonToken (rc/verify daemon-token)', () => {
  const identity = {
    daemonId: DaemonId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    scope: 'install' as const
  }

  it('resolves a verified projected token to an org-less install-wide identity', async () => {
    const svc = new RelayAuthService(codec, repo(null), clock, { HEARTBEAT_SEC: 15 }, { verify: async () => identity })
    expect(await svc.verifyDaemonToken('projected')).toEqual({ daemonId: identity.daemonId })
  })

  it('refuses a token the cluster did not accept', async () => {
    const svc = new RelayAuthService(codec, repo(null), clock, { HEARTBEAT_SEC: 15 }, { verify: async () => null })
    expect(await svc.verifyDaemonToken('projected')).toBeNull()
  })

  it('refuses every token where the deployment provisions no clusters', async () => {
    const svc = new RelayAuthService(codec, repo(null), clock, { HEARTBEAT_SEC: 15 })
    expect(await svc.verifyDaemonToken('projected')).toBeNull()
  })

  it('forwards the claimed daemonId for identity verification', async () => {
    const claims: unknown[] = []
    const svc = new RelayAuthService(
      codec,
      repo(null),
      clock,
      { HEARTBEAT_SEC: 15 },
      {
        verify: async (_token, claim) => {
          claims.push(claim)
          return identity
        }
      }
    )
    expect(await svc.verifyDaemonToken('projected', identity.daemonId)).toEqual({ daemonId: identity.daemonId })
    expect(claims).toEqual([{ daemonId: identity.daemonId }])
  })
})

describe('RelayAuthService.verifyDaemonKey (rc/verify daemon-key, read-only)', () => {
  it('resolves a live daemon key to {daemonId, orgId}', async () => {
    const { token } = codec.mint()
    expect(await service(daemonRecord()).verifyDaemonKey(token)).toEqual({ daemonId: 'daemon-1', orgId: 'org-1' })
  })

  it('rejects a relay/user key, or a daemon key missing its daemonId/orgId', async () => {
    const { token } = codec.mint()
    expect(
      await service(daemonRecord({ principalType: 'relay', daemonId: null, orgId: null })).verifyDaemonKey(token)
    ).toBeNull()
    expect(await service(daemonRecord({ principalType: 'user' })).verifyDaemonKey(token)).toBeNull()
    expect(await service(daemonRecord({ daemonId: null })).verifyDaemonKey(token)).toBeNull()
    expect(await service(daemonRecord({ orgId: null })).verifyDaemonKey(token)).toBeNull()
  })

  it('rejects revoked / expired / unknown / malformed', async () => {
    const { token } = codec.mint()
    expect(await service(daemonRecord({ revokedAt: new Date(NOW - 1) })).verifyDaemonKey(token)).toBeNull()
    expect(await service(daemonRecord({ expiresAt: new Date(NOW - 1) })).verifyDaemonKey(token)).toBeNull()
    expect(await service(null).verifyDaemonKey(token)).toBeNull()
    expect(await service(daemonRecord()).verifyDaemonKey('not-a-key')).toBeNull()
  })

  it('does NOT touch lastUsed (read-only — no side effects)', async () => {
    const { token } = codec.mint()
    const touch = vi.fn(async () => {})
    const repo = { findByHash: vi.fn(async () => daemonRecord()), touchLastUsed: touch } as unknown as ApiKeyRepo
    const svc = new RelayAuthService(codec, repo, clock, { HEARTBEAT_SEC: 15 })
    await svc.verifyDaemonKey(token)
    expect(touch).not.toHaveBeenCalled()
  })

  it('PROPAGATES a store error (so the rc/verify handler can answer retryable, not a false "invalid")', async () => {
    const { token } = codec.mint()
    const repo = {
      findByHash: vi.fn(async () => {
        throw new Error('db down')
      }),
      touchLastUsed: vi.fn(async () => {})
    } as unknown as ApiKeyRepo
    const svc = new RelayAuthService(codec, repo, clock, { HEARTBEAT_SEC: 15 })
    await expect(svc.verifyDaemonKey(token)).rejects.toThrow('db down')
  })
})
