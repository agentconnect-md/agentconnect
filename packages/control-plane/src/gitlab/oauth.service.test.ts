import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  GitlabConnectionRecord,
  GitlabConnectionRepo,
  GitlabConnectionSecretStore,
  GitlabConnectionState,
  GitlabOauthStateRecord,
  GitlabOauthStateStore
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import type { FetchLike } from './api.js'
import { GitlabOauthDenied, GitlabOauthService, normalizeReturnPath } from './oauth.service.js'

const ORG = 'org-1'
const USER = 'user-1'
const sha256 = (v: string) => createHash('sha256').update(v).digest('base64url')

/** Identity cipher with a marker so tests can assert sealing actually happened. */
const cipher: SecretCipher = {
  seal: async (value: string) => `sealed:${value}`,
  open: async (value: string) => value.replace(/^sealed:/, '')
} as unknown as SecretCipher

class MemStates implements GitlabOauthStateStore {
  rows = new Map<string, GitlabOauthStateRecord>()
  async put(input: Omit<GitlabOauthStateRecord, 'browserHash'>): Promise<void> {
    this.rows.set(input.nonce, { ...input, browserHash: null })
  }
  async bindBrowser(nonce: string, browserHash: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    const row = this.rows.get(nonce)
    if (!row || row.browserHash !== null || row.expiresAt <= now) return null
    row.browserHash = browserHash
    return { ...row }
  }
  async consume(nonce: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    const row = this.rows.get(nonce)
    this.rows.delete(nonce)
    return row && row.expiresAt > now ? row : null
  }
}

class MemConnections implements GitlabConnectionRepo {
  rows = new Map<string, GitlabConnectionRecord>()
  private seq = 0
  async upsertOnCallback(input: {
    orgId: string
    userId: string
    gitlabUserId: bigint
    gitlabUsername: string
    scopes: string[]
    accessExpiresAt: Date | null
  }): Promise<GitlabConnectionRecord> {
    const existing = [...this.rows.values()].find(
      (r) => r.orgId === input.orgId && r.gitlabUserId === input.gitlabUserId
    )
    const record: GitlabConnectionRecord = {
      id: existing?.id ?? `conn-${++this.seq}`,
      orgId: input.orgId,
      userId: input.userId,
      gitlabUserId: input.gitlabUserId,
      gitlabUsername: input.gitlabUsername,
      scopes: input.scopes,
      accessExpiresAt: input.accessExpiresAt,
      state: 'connected',
      tokenVersion: (existing?.tokenVersion ?? 0n) + 1n,
      lastSyncAt: new Date(0),
      createdAt: existing?.createdAt ?? new Date(0)
    }
    this.rows.set(record.id, record)
    return record
  }
  async get(orgId: string, id: string): Promise<GitlabConnectionRecord | null> {
    const row = this.rows.get(id)
    return row && row.orgId === orgId ? { ...row } : null
  }
  async listForOrg(orgId: string): Promise<GitlabConnectionRecord[]> {
    return [...this.rows.values()].filter((r) => r.orgId === orgId)
  }
  async setState(orgId: string, id: string, state: GitlabConnectionState): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.orgId !== orgId) return false
    row.state = state
    return true
  }
  leases = new Map<string, { owner: string; until: Date }>()
  async claimRefreshLease(id: string, owner: string, until: Date, now: Date): Promise<boolean> {
    const lease = this.leases.get(id)
    if (lease && lease.owner !== owner && lease.until >= now) return false
    this.leases.set(id, { owner, until })
    return true
  }
  async releaseRefreshLease(id: string, owner: string): Promise<void> {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id)
  }
  async advanceTokenVersion(id: string, expected: bigint, accessExpiresAt: Date | null): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.tokenVersion !== expected) return false
    row.tokenVersion += 1n
    row.accessExpiresAt = accessExpiresAt
    row.state = 'connected'
    return true
  }
}

class MemSecrets implements GitlabConnectionSecretStore {
  rows = new Map<string, { accessToken: string; refreshToken: string }>()
  async put(_orgId: string, id: string, pair: { accessToken: string; refreshToken: string }): Promise<void> {
    this.rows.set(id, { ...pair })
  }
  async get(_orgId: string, id: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }
  async delete(_orgId: string, id: string): Promise<void> {
    this.rows.delete(id)
  }
}

interface Scripted {
  tokenStatus?: number
  refreshCount?: number
}

function gitlabFetch(script: Scripted = {}): FetchLike {
  return async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      const params = new URLSearchParams(String(init?.body ?? ''))
      if (script.tokenStatus) return Response.json({}, { status: script.tokenStatus })
      if (params.get('grant_type') === 'refresh_token') {
        script.refreshCount = (script.refreshCount ?? 0) + 1
        return Response.json({
          access_token: `at-refreshed-${script.refreshCount}`,
          refresh_token: `rt-refreshed-${script.refreshCount}`,
          expires_in: 7200,
          created_at: Math.floor(Date.parse('2026-08-22T00:00:00.000Z') / 1000)
        })
      }
      return Response.json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 7200,
        created_at: Math.floor(Date.parse('2026-08-22T00:00:00.000Z') / 1000),
        scope: 'api'
      })
    }
    if (url.endsWith('/user')) return Response.json({ id: 4242, username: 'example-admin' })
    if (url.endsWith('/oauth/revoke')) return Response.json({})
    throw new Error(`unexpected gitlab call: ${url}`)
  }
}

function harness(opts: { script?: Scripted; now?: number } = {}) {
  const states = new MemStates()
  const connections = new MemConnections()
  const secrets = new MemSecrets()
  const clockNow = { value: opts.now ?? Date.parse('2026-08-22T00:00:00.000Z') }
  const service = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1' },
    connections,
    secrets,
    states,
    cipher,
    clock: { now: () => clockNow.value } as never,
    publicCpUrl: 'https://api.example.test',
    webAppUrl: 'https://console.example.test',
    fetchImpl: gitlabFetch(opts.script ?? {})
  })
  return { service, states, connections, secrets, clockNow }
}

async function connectedHarness(opts: { script?: Scripted } = {}) {
  const h = harness(opts)
  const { url } = await h.service.start(ORG, USER, '/settings/integrations')
  const nonce = new URL(url).searchParams.get('state')!
  const begun = (await h.service.begin(nonce))!
  const done = await h.service.callback(nonce, 'code-1', begun.browserNonce)
  expect(done.result).toBe('connected')
  const record = [...h.connections.rows.values()][0]!
  return { ...h, record }
}

describe('GitlabOauthService (§9)', () => {
  it('start rejects non-local return paths and mints an opaque state', async () => {
    const { service, states } = harness()
    expect(() => normalizeReturnPath('https://evil.example')).toThrow(GitlabOauthDenied)
    expect(() => normalizeReturnPath('//evil.example')).toThrow(GitlabOauthDenied)
    const { url } = await service.start(ORG, USER, '/settings')
    const nonce = new URL(url).searchParams.get('state')!
    expect(url).toBe(`https://api.example.test/v1/gitlab/oauth/begin?state=${nonce}`)
    const row = states.rows.get(nonce)!
    // Opaque state: no org/user ids embedded; the verifier is sealed at rest.
    expect(nonce).not.toContain(ORG)
    expect(row.verifier.startsWith('sealed:')).toBe(true)
  })

  it('begin binds the browser exactly once and builds the PKCE authorize URL', async () => {
    const { service, states } = harness()
    const { url } = await service.start(ORG, USER)
    const nonce = new URL(url).searchParams.get('state')!
    const begun = (await service.begin(nonce))!
    const authorize = new URL(begun.redirectUrl)
    expect(authorize.origin).toBe('https://gitlab.com')
    expect(authorize.searchParams.get('scope')).toBe('api')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    const verifier = states.rows.get(nonce)!.verifier.replace('sealed:', '')
    expect(authorize.searchParams.get('code_challenge')).toBe(sha256(verifier))
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://api.example.test/v1/gitlab/oauth/callback')
    // A replayed begin link cannot re-bind another browser.
    expect(await service.begin(nonce)).toBeNull()
  })

  it('callback consumes once, requires the bound browser, and upserts the starting user', async () => {
    const { service, connections, secrets } = harness()
    const { url } = await service.start(ORG, USER, '/settings')
    const nonce = new URL(url).searchParams.get('state')!
    const begun = (await service.begin(nonce))!

    const wrongBrowser = await service.callback(nonce, 'code-1', 'not-the-cookie')
    expect(wrongBrowser.result).toBe('browser_mismatch')
    // The state is consumed either way: the happy path cannot be replayed after.
    const replay = await service.callback(nonce, 'code-1', begun.browserNonce)
    expect(replay.result).toBe('state_invalid')

    const second = await service.start(ORG, USER, '/settings')
    const nonce2 = new URL(second.url).searchParams.get('state')!
    const begun2 = (await service.begin(nonce2))!
    const done = await service.callback(nonce2, 'code-1', begun2.browserNonce)
    expect(done).toEqual({ redirectPath: '/settings', result: 'connected' })
    const record = [...connections.rows.values()][0]!
    expect(record.userId).toBe(USER)
    expect(record.gitlabUserId).toBe(4242n)
    expect(secrets.rows.get(record.id)).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1' })
    expect(service.redirectTarget('/settings', 'connected')).toBe(
      'https://console.example.test/settings?gitlab=connected'
    )
  })

  it('rejects an expired state', async () => {
    const h = harness()
    const { url } = await h.service.start(ORG, USER)
    const nonce = new URL(url).searchParams.get('state')!
    h.clockNow.value += 16 * 60 * 1000
    expect(await h.service.begin(nonce)).toBeNull()
  })

  it('serves the cached access token while provider expiry is comfortably ahead', async () => {
    const h = await connectedHarness()
    expect(await h.service.withAccessToken(ORG, h.record.id)).toBe('at-1')
  })

  it('refreshes through the lease + CAS once the access token nears expiry', async () => {
    const script: Scripted = {}
    const h = await connectedHarness({ script })
    h.clockNow.value += 3 * 60 * 60 * 1000
    const versionBefore = h.connections.rows.get(h.record.id)!.tokenVersion
    expect(await h.service.withAccessToken(ORG, h.record.id)).toBe('at-refreshed-1')
    expect(h.secrets.rows.get(h.record.id)).toEqual({
      accessToken: 'at-refreshed-1',
      refreshToken: 'rt-refreshed-1'
    })
    expect(h.connections.rows.get(h.record.id)!.tokenVersion).toBe(versionBefore + 1n)
    expect(script.refreshCount).toBe(1)
  })

  it('marks the connection reauth_required on a rejected refresh and never blind-retries', async () => {
    const script: Scripted = {}
    const h = await connectedHarness({ script })
    h.clockNow.value += 3 * 60 * 60 * 1000
    script.tokenStatus = 401
    await expect(h.service.withAccessToken(ORG, h.record.id)).rejects.toThrow(/reauth_required/)
    expect(h.connections.rows.get(h.record.id)!.state).toBe('reauth_required')
    // Administration now requires reconnection; no second refresh attempt happens.
    await expect(h.service.withAccessToken(ORG, h.record.id)).rejects.toThrow(/requires reconnection/)
    expect(script.refreshCount ?? 0).toBe(0)
  })

  it('a contended lease never double-refreshes: the loser reloads the committed pair', async () => {
    const script: Scripted = {}
    const h = await connectedHarness({ script })
    h.clockNow.value += 3 * 60 * 60 * 1000
    const [a, b] = await Promise.allSettled([
      h.service.withAccessToken(ORG, h.record.id),
      h.service.withAccessToken(ORG, h.record.id)
    ])
    const tokens = [a, b].filter((r) => r.status === 'fulfilled').map((r) => (r as { value: string }).value)
    expect(tokens.length).toBeGreaterThanOrEqual(1)
    for (const token of tokens) expect(token).toBe('at-refreshed-1')
    expect(script.refreshCount).toBe(1)
  })

  it('disconnect removes the pair and flips state while keeping the row', async () => {
    const h = await connectedHarness()
    expect(await h.service.disconnect(ORG, h.record.id)).toBe(true)
    expect(h.secrets.rows.has(h.record.id)).toBe(false)
    expect(h.connections.rows.get(h.record.id)!.state).toBe('disconnected')
  })
})
