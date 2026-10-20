import { describe, it, expect, vi } from 'vitest'
import { ComputerService } from './computerService.js'
import { ApiKeyCodec } from './apiKey.js'
import type { ApiKeyRecord, ApiKeyRepo, AuditRepo, ComputerRecord, ComputerRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import { defaultComputerPolicy, readComputerCapabilities } from '../domain/computer.js'

const codec = new ApiKeyCodec({ API_KEY_PEPPER: 'unit-test-pepper-0123456789abcdefghij' })
const NOW = 1_700_000_000_000
const clock = { now: () => NOW } as unknown as Clock
const CID = ComputerId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')

function key(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key_1',
    principalType: 'computer',
    orgId: OrgId('org_1'),
    daemonId: null,
    computerId: CID,
    userId: null,
    displayTail: '…abcd',
    name: null,
    scopes: [],
    permission: 'full',
    allAgents: false,
    agentIds: [],
    agents: [],
    oauthGrantId: null,
    createdAt: new Date(NOW),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over
  }
}

function computer(over: Partial<ComputerRecord> = {}): ComputerRecord {
  return {
    id: CID,
    orgId: OrgId('org_1'),
    name: 'desk',
    ownerUserId: 'u1',
    kind: 'self-hosted',
    isolation: 'none',
    os: 'linux',
    osVersion: 'Ubuntu 26.04',
    session: 'x11',
    status: 'offline',
    capabilities: readComputerCapabilities({}),
    doctor: null,
    desktopDaemonVersion: '0.1.0',
    driverVersion: '0.35.2',
    policy: defaultComputerPolicy('u1'),
    visibility: 'restricted',
    sharedWith: ['u1'],
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...over
  }
}

function service(row: ApiKeyRecord | null, c: ComputerRecord | null = computer(), repo: Partial<ComputerRepo> = {}) {
  const apiKeys = { findByHash: vi.fn(async () => row), touchLastUsed: vi.fn(async () => {}) } as unknown as ApiKeyRepo
  const computers = { getUnscoped: vi.fn(async () => c), ...repo } as unknown as ComputerRepo
  const audit = { append: vi.fn(async () => ({})) } as unknown as AuditRepo
  return { svc: new ComputerService(codec, computers, apiKeys, audit, clock), computers, audit }
}

describe('ComputerService.authenticate — the computer principal', () => {
  it('resolves a live Computer key to exactly its Computer and org', async () => {
    const { token } = codec.mint()
    expect(await service(key()).svc.authenticate(token)).toEqual({ computerId: CID, orgId: 'org_1', apiKeyId: 'key_1' })
  })

  it('refuses every other principal type on the Computer channel', async () => {
    const { token } = codec.mint()
    for (const principalType of ['daemon', 'user', 'relay', 'oauth'] as const) {
      expect(await service(key({ principalType })).svc.authenticate(token), principalType).toBeNull()
    }
  })

  it('refuses a malformed, unknown, revoked, expired, unbound or cross-org key, and a revoked Computer', async () => {
    const { token } = codec.mint()
    expect(await service(key()).svc.authenticate('not-a-key')).toBeNull()
    expect(await service(null).svc.authenticate(token)).toBeNull()
    expect(await service(key({ revokedAt: new Date(NOW - 1) })).svc.authenticate(token)).toBeNull()
    expect(await service(key({ expiresAt: new Date(NOW - 1) })).svc.authenticate(token)).toBeNull()
    expect(await service(key({ computerId: null })).svc.authenticate(token)).toBeNull()
    expect(await service(key({ orgId: null })).svc.authenticate(token)).toBeNull()
    expect(await service(key(), null).svc.authenticate(token)).toBeNull()
    expect(await service(key(), computer({ orgId: OrgId('org_2') })).svc.authenticate(token)).toBeNull()
    expect(await service(key(), computer({ status: 'revoked' })).svc.authenticate(token)).toBeNull()
  })
})

describe('ComputerService.register', () => {
  it('refuses a malformed token without touching storage', async () => {
    const register = vi.fn()
    const { svc } = service(null, null, { register })
    const profile = {
      name: 'desk',
      kind: 'self-hosted' as const,
      isolation: 'none' as const,
      os: 'linux' as const,
      osVersion: 'x',
      session: 'x11' as const,
      capabilities: readComputerCapabilities({}),
      desktopDaemonVersion: '0.1.0',
      driverVersion: '0.35.2'
    }
    expect(await svc.register('nope', profile)).toBeNull()
    expect(register).not.toHaveBeenCalled()
  })

  it('clamps the registration lifetime to the allowed window', async () => {
    const createRegistration = vi.fn(async (input: { expiresAt: Date }) => ({
      id: 'r1',
      orgId: OrgId('org_1'),
      createdByUserId: 'u1',
      displayTail: '…x',
      name: null,
      expiresAt: input.expiresAt,
      consumedAt: null,
      computerId: null,
      createdAt: new Date(NOW)
    }))
    const { svc } = service(null, null, { createRegistration } as unknown as Partial<ComputerRepo>)
    const issued = await svc.createRegistration({ orgId: OrgId('org_1'), createdByUserId: 'u1', ttlMinutes: 10_000 })
    expect(issued.registration.expiresAt.getTime()).toBe(NOW + 24 * 60 * 60_000)
    expect(codec.parse(issued.token)).not.toBeNull()
  })
})
