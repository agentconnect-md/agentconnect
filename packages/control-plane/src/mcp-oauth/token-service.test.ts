import { describe, it, expect, vi } from 'vitest'
import { McpProviderTokenService, refreshMarginMs, MIN_REFRESH_MARGIN_MS } from './token-service.js'
import { PlaintextSecretCipher } from '../secrets/cipher.js'
import { OrgId } from '../domain/ids.js'
import type { GuardedResult } from '../net/guarded-fetch.js'
import type { Dial } from './discovery.js'
import type {
  McpProviderOauthRecord,
  McpProviderOauthRepo,
  McpProviderOauthSecretStore,
  McpSealedTokenPair
} from '../persistence/ports.js'

const ORG = OrgId('org-1')
const PROVIDER = 'provider-1'
const NOW = new Date('2026-09-14T12:00:00Z').getTime()

function record(over: Partial<McpProviderOauthRecord> = {}): McpProviderOauthRecord {
  return {
    mcpProviderId: PROVIDER,
    resource: 'https://mcp.example.test/mcp',
    issuer: 'https://auth.example.test',
    authorizationEndpoint: 'https://auth.example.test/authorize',
    tokenEndpoint: 'https://auth.example.test/token',
    registrationEndpoint: null,
    scopes: ['files:read'],
    clientId: 'client-1',
    clientSource: 'dynamic',
    issParameterSupported: true,
    status: 'connected',
    connectedByUserId: null,
    accessExpiresAt: new Date(NOW + 3600_000),
    tokenVersion: 3n,
    createdAt: new Date(NOW - 86_400_000),
    updatedAt: new Date(NOW - 1_800_000),
    ...over
  }
}

/** An in-memory stand-in for the repo + secret store pair, with the CAS the real one has. */
function fakeStore(initial: McpProviderOauthRecord) {
  let row = initial
  let secrets: { clientSecret: string | null; accessToken: string | null; refreshToken: string | null } | null = {
    clientSecret: null,
    accessToken: 'access-1',
    refreshToken: 'refresh-1'
  }
  let leaseOwner: string | null = null
  const calls = { commit: 0, reauth: 0, claim: 0 }
  const oauth: McpProviderOauthRepo = {
    prepare: vi.fn(),
    connect: vi.fn(),
    get: async () => row,
    claimRefreshLease: async (_id: string, owner: string) => {
      calls.claim++
      if (leaseOwner !== null && leaseOwner !== owner) return false
      leaseOwner = owner
      return true
    },
    releaseRefreshLease: async (_id: string, owner: string) => {
      if (leaseOwner === owner) leaseOwner = null
    },
    commitRefresh: async (_id: string, expected: bigint, accessExpiresAt: Date | null, pair: McpSealedTokenPair) => {
      calls.commit++
      if (expected !== row.tokenVersion) return false
      row = { ...row, tokenVersion: row.tokenVersion + 1n, accessExpiresAt, updatedAt: new Date(NOW) }
      secrets = { clientSecret: secrets?.clientSecret ?? null, ...pair }
      return true
    },
    markReauthRequired: async (_id: string, expected: bigint) => {
      calls.reauth++
      if (expected !== row.tokenVersion) return false
      row = { ...row, status: 'reauth_required' }
      return true
    },
    disconnect: vi.fn(),
    dueForRefresh: vi.fn()
  } as unknown as McpProviderOauthRepo
  const store: McpProviderOauthSecretStore = { get: async () => secrets }
  return {
    oauth,
    store,
    calls,
    read: () => row,
    readSecrets: () => secrets,
    /** Simulate a peer advancing the grant while an upstream call is in flight. */
    bumpVersion: () => {
      row = { ...row, tokenVersion: row.tokenVersion + 1n }
    },
    holdLease: (owner: string) => {
      leaseOwner = owner
    },
    clearSecrets: () => {
      secrets = { clientSecret: null, accessToken: 'access-1', refreshToken: null }
    }
  }
}

const tokenResponse = (json: unknown, status = 200): GuardedResult => ({
  ok: true,
  response: { status, headers: {}, text: JSON.stringify(json), json }
})

function service(store: ReturnType<typeof fakeStore>, dial: Dial, owner = 'cp-test') {
  return new McpProviderTokenService({
    oauth: store.oauth,
    secrets: store.store,
    cipher: new PlaintextSecretCipher(),
    dial,
    clock: { now: () => NOW } as never,
    owner
  })
}

describe('refreshMarginMs', () => {
  it('is half the observed lifetime, floored at a minute', () => {
    expect(refreshMarginMs(0, new Date(3600_000))).toBe(1800_000)
    expect(refreshMarginMs(0, new Date(120_000))).toBe(60_000)
    expect(refreshMarginMs(0, new Date(30_000))).toBe(MIN_REFRESH_MARGIN_MS)
    expect(refreshMarginMs(0, null)).toBe(MIN_REFRESH_MARGIN_MS)
  })
})

describe('McpProviderTokenService.resolve', () => {
  it('serves the stored token without dialing while it is comfortably fresh', async () => {
    const store = fakeStore(record())
    const dial = vi.fn() as unknown as Dial
    const result = await service(store, dial).resolve(ORG, PROVIDER)
    expect(result).toEqual({ ok: true, accessToken: 'access-1', expiresAt: new Date(NOW + 3600_000), rotated: false })
    expect(dial).not.toHaveBeenCalled()
  })

  it('refuses a provider that was never authorized or has been disconnected', async () => {
    const store = fakeStore(record({ status: 'pending' }))
    expect(await service(store, vi.fn() as unknown as Dial).resolve(ORG, PROVIDER)).toEqual({
      ok: false,
      reason: 'not_connected'
    })
  })

  it('never dials in cached-only mode, even when the token is due', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 1_000) }))
    const dial = vi.fn() as unknown as Dial
    const result = await service(store, dial).resolve(ORG, PROVIDER, { allowNetwork: false })
    expect(result).toMatchObject({ ok: true, accessToken: 'access-1', rotated: false })
    expect(dial).not.toHaveBeenCalled()
  })

  it('still hands back the last token for a grant that needs re-authorization', async () => {
    const store = fakeStore(record({ status: 'reauth_required' }))
    const dial = vi.fn() as unknown as Dial
    expect(await service(store, dial).resolve(ORG, PROVIDER)).toMatchObject({ ok: true, accessToken: 'access-1' })
    expect(dial).not.toHaveBeenCalled()
  })

  it('refreshes when the token is inside its margin, persisting the rotated pair', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    const dial = vi.fn(async () =>
      tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    ) as unknown as Dial
    const result = await service(store, dial).resolve(ORG, PROVIDER)
    expect(result).toEqual({ ok: true, accessToken: 'access-2', expiresAt: new Date(NOW + 3600_000), rotated: true })
    expect(store.readSecrets()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' })
  })

  it('keeps the existing refresh token when the server declines to rotate one', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    const dial = vi.fn(async () => tokenResponse({ access_token: 'access-2', expires_in: 600 })) as unknown as Dial
    expect(await service(store, dial).resolve(ORG, PROVIDER)).toMatchObject({ ok: true, rotated: true })
    expect(store.readSecrets()).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-1' })
  })

  it('collapses concurrent callers into one upstream refresh', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    let dials = 0
    const dial = (async () => {
      dials++
      await new Promise((r) => setTimeout(r, 5))
      return tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    }) as unknown as Dial
    const svc = service(store, dial)
    const results = await Promise.all([
      svc.resolve(ORG, PROVIDER),
      svc.resolve(ORG, PROVIDER),
      svc.resolve(ORG, PROVIDER)
    ])
    expect(dials).toBe(1)
    for (const r of results) expect(r).toMatchObject({ ok: true, accessToken: 'access-2' })
  })

  it('serves the stored token instead of racing a peer that already holds the lease', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    store.holdLease('cp-peer')
    const dial = vi.fn() as unknown as Dial
    expect(await service(store, dial).resolve(ORG, PROVIDER)).toMatchObject({ ok: true, accessToken: 'access-1' })
    expect(dial).not.toHaveBeenCalled()
  })

  it('takes the peer write when its own CAS is lost mid-flight', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    const dial = (async () => {
      store.bumpVersion() // a reconnect or a peer landed while we were upstream
      return tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    }) as unknown as Dial
    const result = await service(store, dial).resolve(ORG, PROVIDER)
    expect(result).toEqual({ ok: true, accessToken: 'access-1', expiresAt: new Date(NOW + 30_000), rotated: false })
    expect(store.readSecrets()).toMatchObject({ accessToken: 'access-1' })
  })

  it.each([
    [{ status: 400, body: { error: 'invalid_grant' } }, 'reauth_required'],
    [{ status: 401, body: { error: 'invalid_client' } }, 'reauth_required'],
    [{ status: 200, body: { not: 'a token' } }, 'reauth_required']
  ])('treats a definitive refusal as needing re-authorization (%#)', async ({ status, body }, reason) => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    const dial = (async () => tokenResponse(body, status)) as unknown as Dial
    expect(await service(store, dial).resolve(ORG, PROVIDER)).toEqual({ ok: false, reason })
    expect(store.read().status).toBe('reauth_required')
  })

  it.each([[{ ok: false, failure: 'unreachable' } as GuardedResult], [tokenResponse({ error: 'server_error' }, 503)]])(
    'leaves a working grant alone when the server is unreachable (%#)',
    async (response) => {
      const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
      const dial = (async () => response) as unknown as Dial
      expect(await service(store, dial).resolve(ORG, PROVIDER)).toEqual({ ok: false, reason: 'unreachable' })
      expect(store.read().status).toBe('connected')
      expect(store.calls.reauth).toBe(0)
    }
  )

  it('needs re-authorization once there is no refresh token left to renew with', async () => {
    const store = fakeStore(record({ accessExpiresAt: new Date(NOW + 30_000) }))
    store.clearSecrets()
    const dial = vi.fn() as unknown as Dial
    expect(await service(store, dial).resolve(ORG, PROVIDER)).toEqual({ ok: false, reason: 'reauth_required' })
    expect(dial).not.toHaveBeenCalled()
    expect(store.read().status).toBe('reauth_required')
  })
})

describe('McpProviderTokenService.refresh', () => {
  it('renews regardless of how much life is left', async () => {
    const store = fakeStore(record())
    const dial = vi.fn(async () =>
      tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 })
    ) as unknown as Dial
    expect(await service(store, dial).refresh(ORG, PROVIDER)).toMatchObject({ accessToken: 'access-2', rotated: true })
  })

  it('has nothing to renew for a grant that is not connected', async () => {
    const store = fakeStore(record({ status: 'reauth_required' }))
    expect(await service(store, vi.fn() as unknown as Dial).refresh(ORG, PROVIDER)).toEqual({
      ok: false,
      reason: 'reauth_required'
    })
  })
})
