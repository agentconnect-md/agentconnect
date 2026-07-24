import { describe, it, expect, vi } from 'vitest'
import { DaemonAuthService } from './authService.js'
import { ApiKeyCodec } from './apiKey.js'
import type { ApiKeyRepo, ApiKeyRecord } from '../persistence/ports.js'
import type { EpochService } from '../orchestrator/epoch.js'
import type { Clock } from '../domain/clock.js'
import type { ClientCtx } from '../ports.js'
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

function svc(
  repo: ApiKeyRepo,
  epoch: EpochService,
  webAppUrl?: string,
  orgs: { slugById: (orgId: string) => Promise<string | null> } = { slugById: async () => null }
): DaemonAuthService {
  return new DaemonAuthService(codec, repo, epoch, clock, { HEARTBEAT_SEC: 15, WEB_APP_URL: webAppUrl }, orgs)
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
    expect(r.okFrame.webAppUrl).toBeUndefined() // omitted when WEB_APP_URL is unset
    expect(repo.touchLastUsed).toHaveBeenCalledOnce()
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
