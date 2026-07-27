/**
 * Unit tests for the per-user repo authorization gate (identity assertion,
 * design open question #7): the Logto identity resolution (fake fetch — M2M token
 * caching, login extraction across connector shapes, negative caching) and the
 * GithubUserAuthzService decision matrix. No Docker, no network.
 */
import { describe, it, expect } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { GithubInstallationRecord } from '../persistence/ports.js'
import { LogtoIdentityService, resolveLogtoMgmtConfig, LogtoApiError } from './logto-identity.js'
import { GithubUserAuthzService, UserAuthzDeniedError, type RepoPermission } from './user-authz.js'

const INS = { installationId: 123n } as GithubInstallationRecord

describe('resolveLogtoMgmtConfig', () => {
  it('returns undefined when nothing is set (feature off)', () => {
    expect(resolveLogtoMgmtConfig({})).toBeUndefined()
  })

  it('fails fast on a partial trio, naming the missing vars', () => {
    expect(() => resolveLogtoMgmtConfig({ LOGTO_MGMT_ENDPOINT: 'https://x.logto.app' })).toThrow(
      /missing LOGTO_MGMT_APP_ID, LOGTO_MGMT_APP_SECRET/
    )
  })

  it('defaults the resource to `${endpoint}/api` and strips a trailing slash', () => {
    const cfg = resolveLogtoMgmtConfig({
      LOGTO_MGMT_ENDPOINT: 'https://x.logto.app/',
      LOGTO_MGMT_APP_ID: 'id',
      LOGTO_MGMT_APP_SECRET: 'sec'
    })
    expect(cfg?.endpoint).toBe('https://x.logto.app')
    expect(cfg?.resource).toBe('https://x.logto.app/api')
  })

  it('honors an explicit resource (custom-domain tenants)', () => {
    const cfg = resolveLogtoMgmtConfig({
      LOGTO_MGMT_ENDPOINT: 'https://auth.example.com',
      LOGTO_MGMT_APP_ID: 'id',
      LOGTO_MGMT_APP_SECRET: 'sec',
      LOGTO_MGMT_RESOURCE: 'https://tenant.logto.app/api'
    })
    expect(cfg?.resource).toBe('https://tenant.logto.app/api')
  })
})

const MGMT = { endpoint: 'https://t.logto.app', appId: 'app', appSecret: 'sec', resource: 'https://t.logto.app/api' }

/** Fake Logto: one token endpoint + a user directory. Counts calls. */
function fakeLogto(users: Record<string, unknown>, opts: { tokenTtlSec?: number } = {}) {
  const calls = { token: 0, user: 0 }
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/oidc/token')) {
      calls.token++
      expect(init?.method).toBe('POST')
      const body = String(init?.body)
      expect(body).toContain('grant_type=client_credentials')
      expect(body).toContain(encodeURIComponent('https://t.logto.app/api'))
      return Response.json({ access_token: `tok-${calls.token}`, expires_in: opts.tokenTtlSec ?? 3600 })
    }
    calls.user++
    const sub = decodeURIComponent(url.split('/').pop()!)
    const user = users[sub]
    if (!user) return new Response('{}', { status: 404 })
    return Response.json(user)
  }
  return { fetchImpl, calls }
}

describe('LogtoIdentityService', () => {
  it('resolves the github login from the connector rawData (userInfo shape)', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': { identities: { github: { userId: '9', details: { rawData: { userInfo: { login: 'octocat' } } } } } }
    })
    const svc = new LogtoIdentityService(MGMT, new FakeClock(0), fetchImpl)
    expect(await svc.githubLoginFor('sub-1')).toBe('octocat')
  })

  it('falls back to the flat rawData.login (older connector shape)', async () => {
    const { fetchImpl } = fakeLogto({
      'sub-1': { identities: { github: { details: { rawData: { login: 'flat' } } } } }
    })
    const svc = new LogtoIdentityService(MGMT, new FakeClock(0), fetchImpl)
    expect(await svc.githubLoginFor('sub-1')).toBe('flat')
  })

  it('returns null for accounts without a github identity, and for unknown users', async () => {
    const { fetchImpl } = fakeLogto({ 'sub-google': { identities: { google: { userId: 'g' } } } })
    const svc = new LogtoIdentityService(MGMT, new FakeClock(0), fetchImpl)
    expect(await svc.githubLoginFor('sub-google')).toBeNull()
    expect(await svc.githubLoginFor('sub-missing')).toBeNull()
  })

  it('caches the login (10 min) and the M2M token; a miss is re-asked after 60s', async () => {
    const clock = new FakeClock(0)
    const users: Record<string, unknown> = {}
    const { fetchImpl, calls } = fakeLogto(users)
    const svc = new LogtoIdentityService(MGMT, clock, fetchImpl)

    expect(await svc.githubLoginFor('sub-1')).toBeNull() // 404 → negative cache
    expect(await svc.githubLoginFor('sub-1')).toBeNull() // served from cache
    expect(calls.user).toBe(1)

    clock.advance(61_000) // negative TTL passed; user has linked meanwhile
    users['sub-1'] = { identities: { github: { details: { rawData: { userInfo: { login: 'late' } } } } } }
    expect(await svc.githubLoginFor('sub-1')).toBe('late')
    expect(calls.user).toBe(2)

    clock.advance(60_000) // positive cache holds
    expect(await svc.githubLoginFor('sub-1')).toBe('late')
    expect(calls.user).toBe(2)
    expect(calls.token).toBe(1) // one M2M token covered everything
  })

  it('surfaces mgmt-API failures as retryable LogtoApiError (the gate fails closed)', async () => {
    const fetchImpl = async (url: string): Promise<Response> =>
      url.endsWith('/oidc/token')
        ? Response.json({ access_token: 't', expires_in: 3600 })
        : new Response('boom', { status: 503 })
    const svc = new LogtoIdentityService(MGMT, new FakeClock(0), fetchImpl)
    await expect(svc.githubLoginFor('s')).rejects.toThrow(LogtoApiError)
    await expect(svc.githubLoginFor('s')).rejects.toMatchObject({ retryable: true })
  })
})

// ── decision matrix ──────────────────────────────────────────────────────────

function authz(opts: {
  sub?: string | null
  login?: string | null
  repo?: { private: boolean } | null
  permission?: RepoPermission
  /** Per-repo override keyed by "owner/repo" (falls back to `permission`). */
  permissions?: Record<string, RepoPermission>
}) {
  const clock = new FakeClock(0)
  const calls = { permission: 0, batches: 0 }
  const svc = new GithubUserAuthzService({
    identity: { githubLoginFor: async () => opts.login ?? null },
    users: { getOidcSubject: async () => (opts.sub === undefined ? 'sub-1' : opts.sub) },
    github: {
      getRepoMeta: async () => (opts.repo === undefined ? { private: true } : opts.repo),
      userRepoPermission: async (_ins, owner, repo) => {
        calls.permission++
        return opts.permissions?.[`${owner}/${repo}`] ?? opts.permission ?? 'none'
      },
      userRepoPermissions: async (_ins, repos) => {
        calls.batches++
        calls.permission += repos.length
        return new Map(
          repos.map(({ nodeId, fullName }) => [nodeId, opts.permissions?.[fullName] ?? opts.permission ?? 'none'])
        )
      }
    },
    clock
  })
  return { svc, clock, calls }
}

describe('GithubUserAuthzService', () => {
  it('denies GITHUB_IDENTITY_REQUIRED when the user row has no OIDC subject', async () => {
    const { svc } = authz({ sub: null })
    await expect(svc.assertAccess('u1', INS, 'o', 'r', 'read')).rejects.toMatchObject({
      code: 'GITHUB_IDENTITY_REQUIRED'
    })
  })

  it('denies GITHUB_IDENTITY_REQUIRED when the account has no github identity', async () => {
    const { svc } = authz({ login: null })
    await expect(svc.assertAccess('u1', INS, 'o', 'r', 'read')).rejects.toMatchObject({
      code: 'GITHUB_IDENTITY_REQUIRED'
    })
  })

  it('private + none ⇒ no read; public + none ⇒ read but never write', async () => {
    const closed = authz({ login: 'me', repo: { private: true }, permission: 'none' })
    await expect(closed.svc.assertAccess('u1', INS, 'o', 'r', 'read')).rejects.toMatchObject({
      code: 'USER_NO_ACCESS'
    })

    const open = authz({ login: 'me', repo: { private: false }, permission: 'none' })
    await expect(open.svc.assertAccess('u1', INS, 'o', 'r', 'read')).resolves.toMatchObject({ canRead: true })
    await expect(open.svc.assertAccess('u1', INS, 'o', 'r', 'write')).rejects.toMatchObject({
      code: 'USER_NO_ACCESS'
    })
  })

  it('read permission satisfies read but not write; write/admin satisfy both', async () => {
    const reader = authz({ login: 'me', permission: 'read' })
    await expect(reader.svc.assertAccess('u1', INS, 'o', 'r', 'read')).resolves.toMatchObject({ permission: 'read' })
    await expect(reader.svc.assertAccess('u1', INS, 'o', 'r', 'write')).rejects.toMatchObject({
      code: 'USER_NO_ACCESS'
    })

    for (const permission of ['write', 'admin'] as const) {
      const { svc } = authz({ login: 'me', permission })
      await expect(svc.assertAccess('u1', INS, 'o', 'r', 'write')).resolves.toMatchObject({ canWrite: true })
    }
  })

  it('an out-of-grant repo reads as private/no-access (callers 404 first)', async () => {
    const { svc, calls } = authz({ login: 'me', repo: null })
    await expect(svc.assertAccess('u1', INS, 'o', 'r', 'read')).rejects.toMatchObject({ code: 'USER_NO_ACCESS' })
    expect(calls.permission).toBe(0) // no permission call for a repo the installation can't see
  })

  it('caches the decision for 5 minutes per (installation, repo, login)', async () => {
    const { svc, clock, calls } = authz({ login: 'me', permission: 'write' })
    await svc.assertAccess('u1', INS, 'o', 'r', 'write')
    await svc.assertAccess('u1', INS, 'o', 'r', 'read')
    expect(calls.permission).toBe(1)
    clock.advance(5 * 60_000 + 1)
    await svc.assertAccess('u1', INS, 'o', 'r', 'write')
    expect(calls.permission).toBe(2)
  })

  it('filters the repo list: public stays, readable private stays, no-access private drops', async () => {
    const { svc, calls } = authz({
      login: 'me',
      permissions: { 'o/readable': 'read', 'o/secret': 'none' }
    })
    const page = [
      { nodeId: 'P', fullName: 'o/pub', private: false },
      { nodeId: 'R', fullName: 'o/readable', private: true },
      { nodeId: 'S', fullName: 'o/secret', private: true }
    ]
    const visible = await svc.filterReposForUser('u1', INS, page)
    expect(visible.map((r) => r.fullName)).toEqual(['o/pub', 'o/readable'])
    expect(calls.permission).toBe(2) // public repos are never probed
    expect(calls.batches).toBe(1)
  })

  it('list filter reuses the same permission cache as the gates', async () => {
    const { svc, calls } = authz({ login: 'me', repo: { private: true }, permission: 'read' })
    await svc.filterReposForUser('u1', INS, [{ nodeId: 'R', fullName: 'o/r', private: true }])
    await svc.assertAccess('u1', INS, 'o', 'r', 'read') // cache hit — no second probe
    expect(calls.permission).toBe(1)
    expect(calls.batches).toBe(1)
  })

  it('list filter denies GITHUB_IDENTITY_REQUIRED like every other check', async () => {
    const { svc } = authz({ login: null })
    await expect(
      svc.filterReposForUser('u1', INS, [{ nodeId: 'P', fullName: 'o/pub', private: false }])
    ).rejects.toMatchObject({ code: 'GITHUB_IDENTITY_REQUIRED' })
  })

  it('denial messages carry the effective permission for the write case', async () => {
    const { svc } = authz({ login: 'me', permission: 'read' })
    await expect(svc.assertAccess('u1', INS, 'o', 'r', 'write')).rejects.toThrow(/effective: read/)
    await expect(svc.assertAccess('u1', INS, 'o', 'r', 'write')).rejects.toBeInstanceOf(UserAuthzDeniedError)
  })
})
