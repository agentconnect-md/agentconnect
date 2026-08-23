import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  GitlabConnectionRecord,
  GitlabConnectionRemoval,
  GitlabConnectionRepo,
  GitlabConnectionSecretStore,
  GitlabInstanceStateRecord,
  GitlabInstanceStateRepo,
  GitlabOauthStateRecord,
  GitlabOauthStateStore
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { GitlabApiClient, type FetchLike } from './api.js'
import { GitlabOauthDenied, GitlabOauthService, normalizeReturnPath } from './oauth.service.js'
import { GitlabMembershipGone } from '../persistence/errors.js'

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

class MemInstanceState implements GitlabInstanceStateRepo {
  rows = new Map<string, GitlabInstanceStateRecord>()
  async record(input: GitlabInstanceStateRecord): Promise<void> {
    this.rows.set(input.baseUrl, { ...input })
  }
  async get(baseUrl: string): Promise<GitlabInstanceStateRecord | null> {
    return this.rows.get(baseUrl) ?? null
  }
}

class MemConnections implements GitlabConnectionRepo {
  rows = new Map<string, GitlabConnectionRecord>()
  membershipGone = false
  private seq = 0
  constructor(private readonly secrets: MemSecrets) {}
  async upsertOnCallback(input: {
    orgId: string
    userId: string
    gitlabUserId: bigint
    gitlabUsername: string
    scopes: string[]
    accessExpiresAt: Date | null
    sealedPair: { accessToken: string; refreshToken: string }
  }): Promise<GitlabConnectionRecord> {
    if (this.membershipGone) throw new GitlabMembershipGone()
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
    this.secrets.rows.set(record.id, { ...input.sealedPair })
    return record
  }
  async get(orgId: string, id: string): Promise<GitlabConnectionRecord | null> {
    const row = this.rows.get(id)
    return row && row.orgId === orgId ? { ...row } : null
  }
  async listForOrg(orgId: string): Promise<GitlabConnectionRecord[]> {
    return [...this.rows.values()].filter((r) => r.orgId === orgId)
  }
  async markReauthRequired(id: string, expectedVersion: bigint): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.tokenVersion !== expectedVersion) return false
    row.state = 'reauth_required'
    return true
  }
  async disconnect(orgId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.orgId !== orgId) return false
    row.state = 'disconnected'
    row.tokenVersion += 1n
    this.secrets.rows.delete(id)
    return true
  }
  async remove(orgId: string, id: string): Promise<GitlabConnectionRemoval> {
    const row = this.rows.get(id)
    if (!row || row.orgId !== orgId) return { outcome: 'missing' }
    if (row.state !== 'disconnected') return { outcome: 'not_disconnected' }
    this.rows.delete(id)
    return { outcome: 'removed' }
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
  async commitRefresh(
    id: string,
    expected: bigint,
    accessExpiresAt: Date | null,
    sealedPair: { accessToken: string; refreshToken: string }
  ): Promise<boolean> {
    const row = this.rows.get(id)
    if (!row || row.tokenVersion !== expected || row.state !== 'connected') return false
    row.tokenVersion += 1n
    row.accessExpiresAt = accessExpiresAt
    this.secrets.rows.set(id, { ...sealedPair })
    return true
  }
}

class MemSecrets implements GitlabConnectionSecretStore {
  rows = new Map<string, { accessToken: string; refreshToken: string }>()
  async get(_orgId: string, id: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const row = this.rows.get(id)
    // Mirror the Pg store: values were sealed by the writer, opened on read.
    return row ? { accessToken: unseal(row.accessToken), refreshToken: unseal(row.refreshToken) } : null
  }
}
const unseal = (value: string) => value.replace(/^sealed:/, '')

interface Scripted {
  tokenStatus?: number
  refreshCount?: number
  /** What `GET /version` reports (§24.2); default is at the floor. */
  version?: string
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
    if (url.endsWith('/api/v4/version')) return Response.json({ version: script.version ?? '18.11.0-ee' })
    if (url.endsWith('/user')) return Response.json({ id: 4242, username: 'example-admin' })
    if (url.endsWith('/oauth/revoke')) return Response.json({})
    throw new Error(`unexpected gitlab call: ${url}`)
  }
}

function harness(opts: { script?: Scripted; now?: number; baseUrl?: string } = {}) {
  const states = new MemStates()
  const secrets = new MemSecrets()
  const connections = new MemConnections(secrets)
  const instanceState = new MemInstanceState()
  const clockNow = { value: opts.now ?? Date.parse('2026-08-22T00:00:00.000Z') }
  const baseUrl = opts.baseUrl ?? 'https://gitlab.com'
  const urls: string[] = []
  const record: FetchLike = (url, init) => {
    urls.push(url)
    return gitlabFetch(opts.script ?? {})(url, init)
  }
  const service = new GitlabOauthService({
    cfg: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl },
    connections,
    secrets,
    states,
    instanceState,
    cipher,
    clock: { now: () => clockNow.value } as never,
    publicCpUrl: 'https://api.example.test',
    webAppUrl: 'https://console.example.test',
    api: new GitlabApiClient(baseUrl, record)
  })
  return { service, states, connections, secrets, instanceState, clockNow, urls }
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

  it('composes authorize, token, user, and revoke on a prefixed non-default-port instance (§24.1)', async () => {
    const { service, connections, urls } = harness({ baseUrl: 'https://apps.example.test:8443/gitlab' })
    const { url } = await service.start(ORG, USER)
    const nonce = new URL(url).searchParams.get('state')!
    const begun = (await service.begin(nonce))!
    expect(begun.redirectUrl.startsWith('https://apps.example.test:8443/gitlab/oauth/authorize?')).toBe(true)

    expect((await service.callback(nonce, 'code-1', begun.browserNonce)).result).toBe('connected')
    const connectionId = [...connections.rows.keys()][0]!
    expect(await service.disconnect(ORG, connectionId)).toBe(true)
    // The version read is the FIRST credentialed call, ahead of the user read (§24.2).
    expect(urls).toEqual([
      'https://apps.example.test:8443/gitlab/oauth/token',
      'https://apps.example.test:8443/gitlab/api/v4/version',
      'https://apps.example.test:8443/gitlab/api/v4/user',
      'https://apps.example.test:8443/gitlab/oauth/revoke'
    ])
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
    expect(secrets.rows.get(record.id)).toEqual({ accessToken: 'sealed:at-1', refreshToken: 'sealed:rt-1' })
    expect(service.redirectTarget('/settings', 'connected')).toBe(
      'https://console.example.test/settings?gitlab=connected'
    )
  })

  it('records the observed version and refuses a below-floor instance (§24.2)', async () => {
    for (const version of ['18.10.9-ee', 'not-a-version']) {
      const h = harness({ script: { version } })
      const { url } = await h.service.start(ORG, USER, '/settings')
      const nonce = new URL(url).searchParams.get('state')!
      const begun = (await h.service.begin(nonce))!
      const done = await h.service.callback(nonce, 'code-1', begun.browserNonce)
      expect(done).toEqual({ redirectPath: '/settings', result: 'instance_version_unsupported' })
      // Refused BEFORE the user read, so no connection and no credential exist.
      expect(h.urls).toEqual(['https://gitlab.com/oauth/token', 'https://gitlab.com/api/v4/version'])
      expect(h.connections.rows.size).toBe(0)
      expect(h.secrets.rows.size).toBe(0)
      // Recorded anyway: a refusal an operator cannot read is a silent one.
      expect(await h.instanceState.get('https://gitlab.com')).toMatchObject({ version })
    }
  })

  it('records the observed version of a supported instance on connect (§24.2)', async () => {
    const h = await connectedHarness()
    expect(await h.instanceState.get('https://gitlab.com')).toMatchObject({
      baseUrl: 'https://gitlab.com',
      version: '18.11.0-ee',
      enterprise: true
    })
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
      accessToken: 'sealed:at-refreshed-1',
      refreshToken: 'sealed:rt-refreshed-1'
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

  it('refuses the callback when the starter is no longer an org member (§9.4)', async () => {
    const h = harness()
    const { url } = await h.service.start(ORG, USER)
    const nonce = new URL(url).searchParams.get('state')!
    const begun = (await h.service.begin(nonce))!
    h.connections.membershipGone = true
    const done = await h.service.callback(nonce, 'code-1', begun.browserNonce)
    expect(done.result).toBe('state_invalid')
    expect(h.connections.rows.size).toBe(0)
  })

  it('a stale refresh failure cannot overwrite a newer committed version', async () => {
    const h = await connectedHarness()
    // A reconnect (or any newer commit) advanced the version after this refresh read it.
    expect(await h.connections.markReauthRequired(h.record.id, h.record.tokenVersion - 1n)).toBe(false)
    expect(h.connections.rows.get(h.record.id)!.state).toBe('connected')
  })

  it('disconnect removes the pair and flips state while keeping the row', async () => {
    const h = await connectedHarness()
    expect(await h.service.disconnect(ORG, h.record.id)).toBe(true)
    expect(h.secrets.rows.has(h.record.id)).toBe(false)
    expect(h.connections.rows.get(h.record.id)!.state).toBe('disconnected')
  })
})
