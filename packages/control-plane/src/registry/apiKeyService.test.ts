import { describe, it, expect, vi } from 'vitest'
import { ApiKeyService } from './apiKeyService.js'
import { ApiKeyCodec } from './apiKey.js'
import type { ApiKeyRepo, ApiKeyRecord, DaemonRepo, AuditRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'

const PEPPER = 'unit-test-pepper-0123456789abcdefghij'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })
const NOW = 1_700_000_000_000
const clock = { now: () => NOW } as unknown as Clock

function record(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key_1',
    principalType: 'user',
    orgId: OrgId('org_1'),
    daemonId: null,
    userId: 'usr_1',
    displayTail: '…abcd',
    name: null,
    scopes: [],
    oauthGrantId: null,
    createdAt: new Date(NOW),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...over
  }
}

function service(row: ApiKeyRecord | null): ApiKeyService {
  const repo = {
    findByHash: vi.fn(async () => row),
    touchLastUsed: vi.fn(async () => {})
  } as unknown as ApiKeyRepo
  return new ApiKeyService(
    codec,
    repo,
    {} as DaemonRepo,
    { append: vi.fn(async () => ({})) } as unknown as AuditRepo,
    clock
  )
}

describe('ApiKeyService.authenticateUser — fail-closed contract', () => {
  it('resolves a live user key to its identity + bound org (unrestricted scopes)', async () => {
    const { token } = codec.mint()
    const p = await service(record()).authenticateUser(token)
    expect(p).toEqual({ userId: 'usr_1', orgId: 'org_1', apiKeyId: 'key_1', scopes: [] })
  })

  it('resolves an oauth access token and carries its granted scopes (for the write clamp)', async () => {
    const { token } = codec.mint()
    const oauth = record({ principalType: 'oauth', scopes: ['mcp:read'] })
    expect(await service(oauth).authenticateUser(token)).toEqual({
      userId: 'usr_1',
      orgId: 'org_1',
      apiKeyId: 'key_1',
      scopes: ['mcp:read']
    })
  })

  it('rejects non-user principals (daemon and relay keys never authenticate a human request)', async () => {
    const { token } = codec.mint()
    const daemon = record({ principalType: 'daemon', userId: null, daemonId: 'd' as never })
    expect(await service(daemon).authenticateUser(token)).toBeNull()
    // relay keys are org-less infra credentials — doubly rejected (principal + org guard)
    const relay = record({ principalType: 'relay', userId: null, orgId: null })
    expect(await service(relay).authenticateUser(token)).toBeNull()
  })

  it('rejects a user row without an org binding (corrupt row → fail closed)', async () => {
    const { token } = codec.mint()
    expect(await service(record({ orgId: null })).authenticateUser(token)).toBeNull()
  })

  it('rejects revoked / expired / unknown keys', async () => {
    const { token } = codec.mint()
    expect(await service(record({ revokedAt: new Date(NOW - 1) })).authenticateUser(token)).toBeNull()
    expect(await service(record({ expiresAt: new Date(NOW - 1) })).authenticateUser(token)).toBeNull()
    expect(await service(null).authenticateUser(token)).toBeNull()
    expect(await service(record()).authenticateUser('not-a-key')).toBeNull()
  })
})
