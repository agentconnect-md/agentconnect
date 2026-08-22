import { describe, it, expect, vi } from 'vitest'
import { DaemonAuthService } from './authService.js'
import { ApiKeyCodec } from './apiKey.js'
import type { ApiKeyRepo, ApiKeyRecord } from '../persistence/ports.js'
import type { EpochService } from '../orchestrator/epoch.js'
import { DUTY_LEASE_DEFAULTS } from '../orchestrator/dutyLease.js'
import type { Clock } from '../domain/clock.js'
import type { ClientCtx, ClusterDaemonIdentity } from '../ports.js'
import { OrgId, DaemonId } from '../domain/ids.js'

const PEPPER = 'unit-test-pepper-0123456789abcdefghij'
const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })
const NOW = 1_700_000_000_000
const ctx: ClientCtx = { remoteAddr: '127.0.0.1', subprotocol: 'agentconnect.v1' }
const clock = { now: () => NOW } as unknown as Clock

function record(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key_1',
    principalType: 'daemon',
    orgId: OrgId('org_1'),
    daemonId: DaemonId('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    userId: null,
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

function makeRepo(over: Partial<ApiKeyRepo> = {}): ApiKeyRepo {
  return {
    create: vi.fn(),
    findByHash: vi.fn(async () => record()),
    touchLastUsed: vi.fn(async () => {}),
    revoke: vi.fn(),
    listForDaemon: vi.fn(async () => []),
    ...over
  } as unknown as ApiKeyRepo
}

function makeEpoch(bump: () => Promise<{ sessionEpoch: bigint }>): EpochService {
  return { bumpSessionEpoch: bump } as unknown as EpochService
}

/** The pool, as the ledger's one org-less set. `auth/ok` announces it, and it is the whole
 *  reason the daemon on the other end enforces duty leases at all (daemon-groups.md §3). */
const POOL_SET = { id: '9f11e5e7-0000-4000-8000-000000000001', orgId: null, name: 'Cloud' }
const memberSets = { setOf: async () => POOL_SET }

function svc(
  repo: ApiKeyRepo,
  epoch: EpochService,
  webAppUrl?: string,
  orgs: { slugById: (orgId: string) => Promise<string | null> } = { slugById: async () => null }
): DaemonAuthService {
  return new DaemonAuthService(
    codec,
    repo,
    epoch,
    clock,
    { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs, WEB_APP_URL: webAppUrl },
    orgs,
    memberSets
  )
}

const okEpoch = makeEpoch(async () => ({ sessionEpoch: 7n }))

describe('DaemonAuthService.authenticate — close-code contract', () => {
  it('valid daemon key → ok with minted epoch + heartbeat cadence', async () => {
    const { token } = codec.mint()
    const repo = makeRepo()
    const r = await svc(repo, okEpoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.okFrame.sessionEpoch).toBe(7)
    expect(r.okFrame.heartbeatSec).toBe(15)
    // The daemon's self-fence is derived from this, so it must be THIS CP's horizon.
    expect(r.okFrame.dutyLeaseMs).toBe(DUTY_LEASE_DEFAULTS.leaseMs)
    expect(r.okFrame.webAppUrl).toBeUndefined() // omitted when WEB_APP_URL is unset
    expect(repo.touchLastUsed).toHaveBeenCalledOnce()
  })

  it('announces the daemon’s member set — the daemon’s whole duty-enforcement predicate', async () => {
    const { token } = codec.mint()
    const r = await svc(makeRepo(), okEpoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    if (!r.ok) throw new Error('expected ok')
    expect(r.okFrame.memberSet).toEqual({ setId: POOL_SET.id, name: POOL_SET.name })
    // The connection carries it too, so the duty handlers read a set instead of asking per frame.
    expect(r.setId).toBe(POOL_SET.id)
  })

  it('announces no set for a daemon in none, and that daemon owns its agents outright', async () => {
    const { token } = codec.mint()
    const service = new DaemonAuthService(
      codec,
      makeRepo(),
      okEpoch,
      clock,
      { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
      { slugById: async () => null },
      { setOf: async () => null }
    )
    const r = await service.authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    if (!r.ok) throw new Error('expected ok')
    expect(r.okFrame.memberSet).toBeUndefined()
    expect(r.setId).toBeNull()
  })

  it('fails the handshake 1011 when the membership cannot be read — never “in no set” by accident', async () => {
    // Silently announcing no set would make a pool member serve its agents unfenced. A retry is
    // the only safe answer to a blip here.
    const { token } = codec.mint()
    const service = new DaemonAuthService(
      codec,
      makeRepo(),
      okEpoch,
      clock,
      { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
      { slugById: async () => null },
      {
        setOf: async () => {
          throw new Error('db down')
        }
      }
    )
    expect(await service.authenticate({ apiKey: token, agentVersion: '1' }, ctx)).toMatchObject({
      ok: false,
      closeCode: 1011
    })
  })

  it('includes the configured Web App URL in auth/ok (for daemon session deep links)', async () => {
    const { token } = codec.mint()
    const r = await svc(makeRepo(), okEpoch, 'https://console.example.com').authenticate(
      { apiKey: token, agentVersion: '1' },
      ctx
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.okFrame.webAppUrl).toBe('https://console.example.com')
  })

  it('includes the org slug in auth/ok (the org-scoped deep-link segment)', async () => {
    const { token } = codec.mint()
    const r = await svc(makeRepo(), okEpoch, undefined, { slugById: async () => 'acme' }).authenticate(
      { apiKey: token, agentVersion: '1' },
      ctx
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.okFrame.orgSlug).toBe('acme')
  })

  it('omits orgSlug (still auths) when the slug lookup returns null or throws — best-effort', async () => {
    const { token } = codec.mint()
    const missing = await svc(makeRepo(), okEpoch, undefined, { slugById: async () => null }).authenticate(
      { apiKey: token, agentVersion: '1' },
      ctx
    )
    expect(missing.ok).toBe(true)
    if (!missing.ok) throw new Error('expected ok')
    expect(missing.okFrame.orgSlug).toBeUndefined()

    const throws = await svc(makeRepo(), okEpoch, undefined, {
      slugById: async () => {
        throw new Error('db blip')
      }
    }).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    expect(throws.ok).toBe(true) // a slug-lookup failure must not fail an otherwise-good auth
    if (!throws.ok) throw new Error('expected ok')
    expect(throws.okFrame.orgSlug).toBeUndefined()
  })

  it('malformed key → 4401 with NO DB lookup', async () => {
    const repo = makeRepo()
    const r = await svc(repo, okEpoch).authenticate({ apiKey: 'not-a-key', agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
    expect(repo.findByHash).not.toHaveBeenCalled()
  })

  it('unknown key (hash miss) → 4401', async () => {
    const repo = makeRepo({ findByHash: vi.fn(async () => null) })
    const { token } = codec.mint()
    const r = await svc(repo, okEpoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('revoked / expired / user-principal / relay-principal / unbound / org-less key → 4401', async () => {
    const { token } = codec.mint()
    const cases: Partial<ApiKeyRecord>[] = [
      { revokedAt: new Date(NOW - 1000) },
      { expiresAt: new Date(NOW - 1000) },
      { principalType: 'user', daemonId: null, userId: 'u1' },
      // a relay credential must never authenticate the daemon WS
      { principalType: 'relay', daemonId: null, orgId: null },
      { daemonId: null },
      // a daemon key is always org-scoped; a null org is a corrupt row → fail closed
      { orgId: null }
    ]
    for (const over of cases) {
      const repo = makeRepo({ findByHash: vi.fn(async () => record(over)) })
      const r = await svc(repo, okEpoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
      expect(r).toMatchObject({ ok: false, closeCode: 4401 })
    }
  })

  it('echoed daemonId mismatch → 4401', async () => {
    const { token } = codec.mint()
    const repo = makeRepo() // row.daemonId = dddd…
    const r = await svc(repo, okEpoch).authenticate(
      { apiKey: token, daemonId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', agentVersion: '1' },
      ctx
    )
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('findByHash throws (transient DB) → 1011 retryable', async () => {
    const repo = makeRepo({
      findByHash: vi.fn(async () => {
        throw new Error('db down')
      })
    })
    const { token } = codec.mint()
    const r = await svc(repo, okEpoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 1011 })
  })

  it('epoch bump throws → 1011 retryable (no auth/ok)', async () => {
    const repo = makeRepo()
    const epoch = makeEpoch(async () => {
      throw new Error('fk violation')
    })
    const { token } = codec.mint()
    const r = await svc(repo, epoch).authenticate({ apiKey: token, agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 1011 })
  })
})

describe('DaemonAuthService.authenticate — the in-cluster token path', () => {
  const verified = {
    daemonId: DaemonId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    scope: 'install' as const
  }
  const orgs = { slugById: async () => 'cluster-org' }

  function withIdentity(verify: ClusterDaemonIdentity['verify'], repo = makeRepo()): DaemonAuthService {
    return new DaemonAuthService(
      codec,
      repo,
      okEpoch,
      clock,
      { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
      orgs,
      memberSets,
      { verify }
    )
  }

  it('a verified token authenticates an install-wide member without any API key', async () => {
    const repo = makeRepo()
    const r = await withIdentity(async () => verified, repo).authenticate(
      { serviceAccountToken: 'projected', agentVersion: '1' },
      ctx
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.daemonId).toBe(verified.daemonId)
    expect(r.okFrame.sessionEpoch).toBe(7)
    // A pool identity names no org, so the org rides each frame instead of the connection.
    expect(r.orgId).toBeNull()
    expect(r.okFrame.organizationMode).toBe('frame')
    expect(r.okFrame.orgSlug).toBeUndefined()
    // No key was presented, so nothing may be looked up or touched.
    expect(repo.findByHash).not.toHaveBeenCalled()
    expect(repo.touchLastUsed).not.toHaveBeenCalled()
  })

  it('the token wins over a presented key, so a stale key cannot pick the daemon', async () => {
    const { token } = codec.mint()
    const repo = makeRepo()
    const r = await withIdentity(async () => verified, repo).authenticate(
      { apiKey: token, serviceAccountToken: 'projected', agentVersion: '1' },
      ctx
    )
    expect(r).toMatchObject({ ok: true, daemonId: verified.daemonId })
    expect(repo.findByHash).not.toHaveBeenCalled()
  })

  it('a token presented to a deployment that provisions no clusters → 4401', async () => {
    const r = await svc(makeRepo(), okEpoch).authenticate({ serviceAccountToken: 'projected', agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('a refused token → 4401, no epoch bump', async () => {
    const epoch = makeEpoch(async () => {
      throw new Error('must not be reached')
    })
    const service = new DaemonAuthService(
      codec,
      makeRepo(),
      epoch,
      clock,
      { HEARTBEAT_SEC: 15, DUTY_LEASE_MS: DUTY_LEASE_DEFAULTS.leaseMs },
      orgs,
      memberSets,
      {
        verify: async () => null
      }
    )
    const r = await service.authenticate({ serviceAccountToken: 'projected', agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('a verifier that throws → 1011 retryable, not a dead identity', async () => {
    const r = await withIdentity(async () => {
      throw new Error('api server unreachable')
    }).authenticate({ serviceAccountToken: 'projected', agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 1011 })
  })

  it('forwards only the optional daemon id to the Kubernetes verifier', async () => {
    const claims: unknown[] = []
    const r = await withIdentity(async (_token, claim) => {
      claims.push(claim)
      return verified
    }).authenticate({ serviceAccountToken: 'projected', daemonId: verified.daemonId, agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: true, daemonId: verified.daemonId })
    expect(claims).toEqual([{ daemonId: verified.daemonId }])
  })

  it('an echoed daemonId that disagrees with the identity → 4401', async () => {
    const r = await withIdentity(async () => verified).authenticate(
      { serviceAccountToken: 'projected', daemonId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', agentVersion: '1' },
      ctx
    )
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
  })

  it('no credential at all → 4401 with no DB call', async () => {
    const repo = makeRepo()
    const r = await svc(repo, okEpoch).authenticate({ agentVersion: '1' }, ctx)
    expect(r).toMatchObject({ ok: false, closeCode: 4401 })
    expect(repo.findByHash).not.toHaveBeenCalled()
  })
})
