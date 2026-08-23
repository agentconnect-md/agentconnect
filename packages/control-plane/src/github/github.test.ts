/**
 * Unit tests for the github module (no Docker, no network): config decoding,
 * App JWT claims, install-state HMAC round-trip, installation-token cache
 * thresholds + single-flight + error mapping, and the mint-path token bucket.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { jwtVerify } from 'jose'
import type { GitCredCapability } from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import type { AgentRepoAuthorizationRecord, GithubInstallationRecord } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { githubAppBotIdentity, resolveGithubAppConfig, type GithubAppConfig } from './config.js'
import { GithubApiError, githubRequest, mintAppJwt, type FetchLike } from './api.js'
import { InstallationTokenInvalidatedError, InstallationTokenService } from './installation-token.service.js'
import { deriveInstallStateKey, mintInstallState, verifyInstallState, INSTALL_STATE_TTL_MS } from './install-state.js'
import { GithubService } from './service.js'
import { TokenBucket } from './rate-limit.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM_B64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64')
// GitHub downloads keys as PKCS#1 — the config loader must accept that form too.
const PKCS1_B64 = Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string).toString('base64')

function cfg(overrides: Partial<GithubAppConfig> = {}): GithubAppConfig {
  return { appId: 2345678, slug: 'example-login-app', jwtIssuer: '2345678', privateKey, ...overrides }
}

describe('resolveGithubAppConfig', () => {
  it('returns undefined when nothing is set (feature off)', () => {
    expect(resolveGithubAppConfig({})).toBeUndefined()
  })

  it('fails fast on a partial trio, naming the missing vars', () => {
    expect(() => resolveGithubAppConfig({ GITHUB_APP_ID: 1 })).toThrow(/missing GITHUB_APP_PRIVATE_KEY_B64/)
  })

  it('decodes both PKCS#8 and PKCS#1 (GitHub download format) keys', () => {
    for (const b64 of [PEM_B64, PKCS1_B64]) {
      const c = resolveGithubAppConfig({
        GITHUB_APP_ID: 2345678,
        GITHUB_APP_PRIVATE_KEY_B64: b64,
        GITHUB_APP_SLUG: 'example-login-app'
      })
      expect(c?.appId).toBe(2345678)
      expect(c?.privateKey.asymmetricKeyType).toBe('rsa')
    }
  })

  it('uses the client id as JWT issuer when configured, else the app id', () => {
    const base = { GITHUB_APP_ID: 7, GITHUB_APP_PRIVATE_KEY_B64: PEM_B64, GITHUB_APP_SLUG: 's' }
    expect(resolveGithubAppConfig(base)?.jwtIssuer).toBe('7')
    expect(resolveGithubAppConfig({ ...base, GITHUB_APP_CLIENT_ID: 'Iv23liX' })?.jwtIssuer).toBe('Iv23liX')
  })

  it('rejects garbage keys with a clear error', () => {
    expect(() =>
      resolveGithubAppConfig({
        GITHUB_APP_ID: 1,
        GITHUB_APP_PRIVATE_KEY_B64: Buffer.from('not a pem').toString('base64'),
        GITHUB_APP_SLUG: 's'
      })
    ).toThrow(/does not decode to a parsable private key/)
  })
})

describe('githubAppBotIdentity', () => {
  it('derives each deployment bot identity from its configured App slug', () => {
    expect(githubAppBotIdentity('agentconnect-example-alpha', 101)).toEqual({
      name: 'agentconnect-example-alpha[bot]',
      email: '101+agentconnect-example-alpha[bot]@users.noreply.github.com'
    })
    expect(githubAppBotIdentity('agentconnect-example-beta', 202)).toEqual({
      name: 'agentconnect-example-beta[bot]',
      email: '202+agentconnect-example-beta[bot]@users.noreply.github.com'
    })
  })
})

describe('GithubService.getGitCommitIdentity', () => {
  it('resolves the numeric bot user id once and omits auth on the public lookup', async () => {
    let calls = 0
    const service = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl: async (url, init) => {
        calls += 1
        expect(url).toContain('/users/example-login-app%5Bbot%5D')
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        return Response.json({ id: 345_678_901, login: 'example-login-app[bot]', type: 'Bot' })
      }
    })

    const expected = {
      name: 'example-login-app[bot]',
      email: '345678901+example-login-app[bot]@users.noreply.github.com'
    }
    await expect(service.getGitCommitIdentity()).resolves.toEqual(expected)
    await expect(service.getGitCommitIdentity()).resolves.toEqual(expected)
    expect(calls).toBe(1)
  })

  it('caches lookup failure and omits the identity', async () => {
    let calls = 0
    const warn = vi.fn()
    const service = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      log: { warn },
      fetchImpl: async () => {
        calls += 1
        return Response.json({ message: 'Not Found' }, { status: 404 })
      }
    })

    await expect(service.getGitCommitIdentity()).resolves.toBeUndefined()
    await expect(service.getGitCommitIdentity()).resolves.toBeUndefined()
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('commit attribution disabled'))
  })
})

describe('githubRequest', () => {
  it('bigIdsAsStrings keeps 19-digit delivery ids exact (JSON.parse would round them)', async () => {
    // Real webhook delivery ids exceed Number.MAX_SAFE_INTEGER — a plain parse
    // rounds 1234567890123456789 and the redeliver POST would target the wrong id.
    const body = '[{"id":1234567890123456789,"guid":"g-1","event":"ping","repository_id":42}]'
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    const rows = await githubRequest<Array<{ id: string; repository_id: number }>>('/app/hook/deliveries', {
      auth: 'jwt',
      fetchImpl,
      bigIdsAsStrings: true
    })
    expect(rows[0]!.id).toBe('1234567890123456789')
    expect(rows[0]!.repository_id).toBe(42) // small ids stay numbers

    // Without the flag the mangling is real — this is the trap the option closes.
    const mangled = await githubRequest<Array<{ id: number }>>('/x', { auth: 'jwt', fetchImpl })
    expect(String(mangled[0]!.id)).not.toBe('1234567890123456789')
  })

  it('an empty 2xx body (202 redelivery accepted) resolves instead of throwing on parse', async () => {
    const fetchImpl = async () => new Response(null, { status: 202 })
    await expect(
      githubRequest<unknown>('/x/attempts', { method: 'POST', auth: 'jwt', fetchImpl })
    ).resolves.toBeUndefined()
  })
})

describe('GithubService.listHookDeliveries', () => {
  const deliveryPage = (guids: string[], at: string): string =>
    JSON.stringify(
      guids.map((guid) => ({
        id: '1234567890123456789',
        guid,
        delivered_at: at,
        event: 'pull_request',
        action: 'opened',
        repository_id: 42,
        installation_id: 7
      }))
    )
  const svc = (fetchImpl: FetchLike) =>
    new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })

  it('walks the cursor until a page reaches past the floor', async () => {
    const paths: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      paths.push(url)
      const second = url.includes('cursor=next')
      return new Response(
        second ? deliveryPage(['old'], '2023-11-14T21:40:00.000Z') : deliveryPage(['new'], '2023-11-14T22:10:00.000Z'),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"'
          }
        }
      )
    })

    const page = await svc(fetchImpl).listHookDeliveries({ deliveredSince: new Date('2023-11-14T21:50:00.000Z') })
    expect(page.deliveries.map((d) => d.guid)).toEqual(['new', 'old'])
    expect(page.truncated).toBe(false) // the second page reaches past the floor
    expect(paths[1]).toContain('cursor=next')
  })

  it('reports truncation when the page budget runs out before the floor', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(deliveryPage(['g'], '2023-11-14T22:10:00.000Z'), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"'
          }
        })
    )

    const page = await svc(fetchImpl).listHookDeliveries({
      maxPages: 3,
      deliveredSince: new Date('2023-11-14T20:00:00.000Z')
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(page.truncated).toBe(true)
  })

  it('never follows a next cursor that points off the API base', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(deliveryPage(['g'], '2023-11-14T22:10:00.000Z'), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://evil.example/app/hook/deliveries?cursor=next>; rel="next"'
          }
        })
    )

    const page = await svc(fetchImpl).listHookDeliveries({ deliveredSince: new Date('2023-11-14T20:00:00.000Z') })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(page.truncated).toBe(false)
  })
})

describe('GithubService comment authorization lookups', () => {
  const installation: GithubInstallationRecord = {
    id: 'installation-row',
    orgId: 'org-a' as never,
    installationId: 42n,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspendedAt: null,
    permissions: { metadata: 'read' },
    revokedAt: null,
    createdAt: new Date(0)
  }

  function harness(status: number, body: Record<string, unknown> = { message: 'test failure' }): GithubService {
    const service = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl: async () => Response.json(body, { status })
    })
    vi.spyOn(service.tokens, 'metadataToken').mockResolvedValue('ghs_test')
    return service
  }

  it('treats HTTP 404 as a definitive missing subject', async () => {
    const service = harness(404)
    await expect(service.repoRefForCommentAuthz(installation, 'acme', 'repo')).resolves.toBeNull()
    await expect(service.userRepoPermissionForCommentAuthz(installation, 'acme', 'repo', 'octocat')).resolves.toBe(
      'none'
    )
  })

  it('propagates HTTP 403 as an operational authorization failure', async () => {
    const service = harness(403)
    await expect(service.repoRefForCommentAuthz(installation, 'acme', 'repo')).rejects.toMatchObject({ status: 403 })
    await expect(
      service.userRepoPermissionForCommentAuthz(installation, 'acme', 'repo', 'octocat')
    ).rejects.toMatchObject({ status: 403 })
  })

  it('reads the built-in triage role that the legacy permission field reports as read', async () => {
    const service = harness(200, { permission: 'read', role_name: 'triage' })

    await expect(service.userRepoPermissionForCommentAuthz(installation, 'acme', 'repo', 'octocat')).resolves.toBe(
      'triage'
    )
    // gitAccess keeps GitHub's legacy granularity, where triage is not repository write.
    await expect(service.userRepoPermission(installation, 'acme', 'repo', 'octocat')).resolves.toBe('read')
  })

  it('leaves maintain collapsed as the legacy write it already arrives as', async () => {
    const service = harness(200, { permission: 'write', role_name: 'maintain' })

    await expect(service.userRepoPermissionForCommentAuthz(installation, 'acme', 'repo', 'octocat')).resolves.toBe(
      'write'
    )
  })

  it('never promotes a custom role whose name merely resembles triage', async () => {
    const service = harness(200, { permission: 'read', role_name: 'triage-plus' })

    await expect(service.userRepoPermissionForCommentAuthz(installation, 'acme', 'repo', 'octocat')).resolves.toBe(
      'read'
    )
  })
})

describe('mintAppJwt', () => {
  it('delegates RS256 signing to auth-app while preserving the configured JWT issuer', async () => {
    const nowMs = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(nowMs)
    try {
      const jwt = await mintAppJwt(cfg({ jwtIssuer: 'Iv23liX' }))
      const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
        issuer: 'Iv23liX',
        currentDate: new Date(nowMs)
      })
      const nowSec = nowMs / 1000
      expect(protectedHeader.alg).toBe('RS256')
      expect(payload.iat).toBeGreaterThanOrEqual(nowSec - 60)
      expect(payload.iat).toBeLessThanOrEqual(nowSec)
      expect(payload.exp).toBeGreaterThan(nowSec)
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('install state', () => {
  const key = deriveInstallStateKey('p'.repeat(32))

  it('round-trips orgId + nonce and enforces expiry inside the signature', () => {
    const clock = new FakeClock(1_700_000_000_000)
    const minted = mintInstallState(key, 'org_1', clock)
    const ok = verifyInstallState(key, minted.state, clock)
    expect(ok).toEqual({ orgId: 'org_1', nonce: minted.nonce, expiresAt: minted.expiresAt })

    clock.advance(INSTALL_STATE_TTL_MS + 1000)
    expect(verifyInstallState(key, minted.state, clock)).toBeNull()
  })

  it('rejects tampered payloads and foreign keys', () => {
    const clock = new FakeClock(1_700_000_000_000)
    const minted = mintInstallState(key, 'org_1', clock)
    const [payload, sig] = minted.state.split('.')
    const forged = Buffer.from(JSON.stringify({ o: 'org_EVIL', e: 9999999999, n: 'x' })).toString('base64url')
    expect(verifyInstallState(key, `${forged}.${sig}`, clock)).toBeNull()
    expect(verifyInstallState(deriveInstallStateKey('q'.repeat(32)), `${payload}.${sig}`, clock)).toBeNull()
    expect(verifyInstallState(key, 'garbage', clock)).toBeNull()
  })
})

describe('GithubService.sync', () => {
  it('refreshes only durable org claims and never scans the App-wide installation roster', async () => {
    const claimed = {
      id: 'row-42',
      orgId: 'org-a',
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      revokedAt: null,
      permissions: {},
      createdAt: new Date(0)
    } as GithubInstallationRecord
    const revoked = {
      ...claimed,
      id: 'row-43',
      installationId: 43n,
      accountLogin: 'gone',
      revokedAt: new Date(1)
    }
    const refreshed = { ...claimed, permissions: { checks: 'write' } }
    const upsertFromGithub = vi.fn(async () => refreshed)
    const markRevokedByInstallationId = vi.fn(async () => {})
    const listForOrg = vi.fn(async () => [refreshed])
    const onInstallationFactsChanged = vi.fn()
    const urls: string[] = []
    const svc = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {
        listClaimsForOrg: vi.fn(async () => [claimed, revoked]),
        listForOrg,
        upsertFromGithub,
        markRevokedByInstallationId
      } as never,
      installState: { put: async () => {}, consume: async () => true },
      onInstallationFactsChanged,
      pepper: 'p'.repeat(32),
      fetchImpl: async (url) => {
        urls.push(url)
        if (url.endsWith('/app/installations/42')) {
          return Response.json({
            id: 42,
            account: { login: 'acme', type: 'Organization' },
            repository_selection: 'all',
            suspended_at: null,
            permissions: { checks: 'write' }
          })
        }
        if (url.endsWith('/app/installations/43')) return Response.json({ message: 'Not Found' }, { status: 404 })
        throw new Error(`unexpected GitHub request: ${url}`)
      }
    })

    await expect(svc.sync(claimed.orgId)).resolves.toEqual([refreshed])

    expect(urls).toEqual(['https://api.github.com/app/installations/42', 'https://api.github.com/app/installations/43'])
    expect(upsertFromGithub).toHaveBeenCalledOnce()
    expect(upsertFromGithub).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({ installationId: 42n, permissions: { checks: 'write' } })
    )
    expect(markRevokedByInstallationId).toHaveBeenCalledWith(43n)
    expect(onInstallationFactsChanged.mock.calls).toEqual([
      [42n, 'org-a'],
      [43n, 'org-a']
    ])
    expect(listForOrg).toHaveBeenCalledWith('org-a')
  })
})

describe('GithubService.outdatedInstallations', () => {
  it("reads GitHub's outdated installation filter and briefly caches the result", async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const urls: string[] = []
    let responseId = 123456789
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl: async (url) => {
        urls.push(url)
        return Response.json([
          {
            id: responseId,
            account: { login: 'acme', type: 'Organization' },
            repository_selection: 'selected',
            suspended_at: null,
            html_url: `https://github.com/organizations/acme/settings/installations/${responseId}`
          }
        ])
      }
    })

    const first = await svc.outdatedInstallations()
    expect(urls[0]).toContain('/app/installations?outdated=true&per_page=100&page=1')
    expect(first.get('123456789')).toBe('https://github.com/organizations/acme/settings/installations/123456789')

    responseId = 123456790
    expect(await svc.outdatedInstallations()).toBe(first)
    expect(urls).toHaveLength(1)

    const forced = await svc.outdatedInstallations(true)
    expect(urls).toHaveLength(2)
    expect(forced.has('123456789')).toBe(false)
    expect(forced.has('123456790')).toBe(true)
  })
})

describe('GithubService repository picker reads', () => {
  const installation: GithubInstallationRecord = {
    id: 'installation-row',
    orgId: 'org-a' as never,
    installationId: 42n,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspendedAt: null,
    permissions: { metadata: 'read' },
    revokedAt: null,
    createdAt: new Date(0)
  }

  it('caches repository pages until the installation roster is invalidated', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const fetchImpl = vi.fn(async () =>
      Response.json({
        total_count: 1,
        repositories: [
          {
            id: 1,
            full_name: 'acme/one',
            private: true,
            default_branch: 'main',
            description: null
          }
        ]
      })
    )
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    vi.spyOn(svc.tokens, 'metadataToken').mockResolvedValue('ghs_metadata')

    await svc.listRepos(installation, 1, 100)
    await svc.listRepos(installation, 1, 100)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    svc.invalidateRepositoryRoster(installation.installationId)
    await svc.listRepos(installation, 1, 100)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    // Concurrent pickers share one request rather than racing the same page.
    await Promise.all([svc.listRepos(installation, 2, 100), svc.listRepos(installation, 2, 100)])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('resolves a durable repository id to its current name through the installation grant', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/repositories/123')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghs_metadata')
      return Response.json({
        id: 123,
        full_name: 'acme/renamed-repo',
        private: true,
        default_branch: 'main',
        description: null
      })
    })
    const svc = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    vi.spyOn(svc.tokens, 'metadataToken').mockResolvedValue('ghs_metadata')

    await expect(svc.repoRefById(installation, 123n)).resolves.toEqual({
      repoId: 123n,
      fullName: 'acme/renamed-repo',
      private: true,
      defaultBranch: 'main'
    })
  })
})

describe('GithubService.uninstallInstallation', () => {
  it('uninstalls with App auth, treats an already-gone installation as success, and invalidates the cache', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const calls: Array<{ url: string; method: string }> = []
    let deleteStatus = 202
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init?.method ?? 'GET' })
        if (init?.method === 'DELETE') {
          return deleteStatus === 202 || deleteStatus === 204
            ? new Response(null, { status: deleteStatus })
            : Response.json({ message: 'Not Found' }, { status: deleteStatus })
        }
        return Response.json([])
      }
    })

    // Prime the permission-health cache, then prove uninstall clears it.
    await svc.outdatedInstallations()
    await svc.uninstallInstallation(123456789n)
    await svc.outdatedInstallations()
    expect(calls.map(({ method }) => method)).toEqual(['GET', 'DELETE', 'GET'])
    expect(calls[1]!.url).toContain('/app/installations/123456789')

    deleteStatus = 404
    await expect(svc.uninstallInstallation(123456789n)).resolves.toBeUndefined()
    deleteStatus = 410
    await expect(svc.uninstallInstallation(123456789n)).resolves.toBeUndefined()
  })

  it('preserves non-terminal uninstall failures', async () => {
    const svc = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: {} as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl: async () => Response.json({ message: 'service unavailable' }, { status: 503 })
    })

    await expect(svc.uninstallInstallation(123456789n)).rejects.toMatchObject({ status: 503, code: 'INTERNAL' })
  })
})

describe('InstallationTokenService', () => {
  const IID = 42n

  function service(clock: FakeClock, responder: (calls: number) => Response | Promise<Response>) {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return responder(calls)
    }
    const svc = new InstallationTokenService(cfg(), clock, fetchImpl)
    return { svc, calls: () => calls }
  }

  function tokenResponse(token: string, expiresAtMs: number): Response {
    return new Response(JSON.stringify({ token, expires_at: new Date(expiresAtMs).toISOString() }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    })
  }

  it('mints once, serves from cache while >15min remain, re-mints after', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, calls } = service(clock, (n) => tokenResponse(`ghs_${n}`, clock.now() + 3_600_000))

    const a = await svc.mint(IID, 'acme/infra', 'write')
    expect(a.token).toBe('ghs_1')
    // 60s skew shaved: 3600s − 60s
    expect(a.ttlSec).toBe(3540)

    const b = await svc.mint(IID, 'acme/infra', 'write')
    expect(b.token).toBe('ghs_1')
    expect(calls()).toBe(1)

    // 46min later: 3540s − 2760s = 780s < 15min ⇒ miss ⇒ fresh mint
    clock.advance(46 * 60 * 1000)
    const c = await svc.mint(IID, 'acme/infra', 'write')
    expect(c.token).toBe('ghs_2')
    expect(calls()).toBe(2)
  })

  it('coalesces concurrent same-key mints (retransmit idempotency)', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, calls } = service(clock, (n) => tokenResponse(`ghs_${n}`, clock.now() + 3_600_000))
    const [a, b, c] = await Promise.all([
      svc.mint(IID, 'acme/infra', 'write'),
      svc.mint(IID, 'acme/infra', 'write'),
      svc.mint(IID, 'acme/infra', 'write')
    ])
    expect(calls()).toBe(1)
    expect(a.token).toBe('ghs_1')
    expect(b.token).toBe('ghs_1')
    expect(c.token).toBe('ghs_1')
  })

  it('keys the cache by access level and repo', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, calls } = service(clock, (n) => tokenResponse(`ghs_${n}`, clock.now() + 3_600_000))
    await svc.mint(IID, 'acme/infra', 'write')
    await svc.mint(IID, 'acme/infra', 'read')
    await svc.mint(IID, 'acme/other', 'write')
    expect(calls()).toBe(3)
  })

  it('capabilities widen permissions at the ACCESS level and key the cache (P2.5)', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return tokenResponse(`ghs_${calls}`, clock.now() + 3_600_000)
    }
    const svc = new InstallationTokenService(cfg(), clock, fetchImpl)

    // Write workspace + full set ⇒ write-level workflow/issue/PR/Actions scopes.
    await svc.mint(IID, 'acme/infra', 'write', ['contents', 'issues', 'pull_requests', 'actions'])
    expect(bodies[0]!.permissions).toEqual({
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions: 'write',
      workflows: 'write'
    })
    // Read workspace ⇒ every capability CLAMPED to read (never a write scope).
    await svc.mint(IID, 'acme/infra', 'read', ['contents', 'issues', 'pull_requests', 'actions'])
    expect(bodies[1]!.permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      issues: 'read',
      pull_requests: 'read',
      actions: 'read'
    })
    // Default (absent) capabilities keep the pre-P2.5 contents shape, with
    // workflow writes coupled to contents writes.
    await svc.mint(IID, 'acme/infra', 'write')
    expect(bodies[2]!.permissions).toEqual({ metadata: 'read', contents: 'write', workflows: 'write' })
    // Distinct capability sets are distinct cache entries — but the same set
    // (regardless of order/duplicates) hits the same one.
    expect(calls).toBe(3)
    await svc.mint(IID, 'acme/infra', 'write', ['pull_requests', 'actions', 'issues', 'contents', 'issues'])
    expect(calls).toBe(3)
  })

  it('maps GitHub failures onto wire error codes and clears the in-flight slot', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, calls } = service(clock, (n) =>
      n === 1
        ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        : tokenResponse(`ghs_${n}`, clock.now() + 3_600_000)
    )
    await expect(svc.mint(IID, 'acme/infra', 'write')).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: false
    } satisfies Partial<GithubApiError>)
    // the failed in-flight promise must not be sticky
    const ok = await svc.mint(IID, 'acme/infra', 'write')
    expect(ok.token).toBe('ghs_2')
    expect(calls()).toBe(2)
  })

  it('maps primary-rate-limit 403s to RATE_LIMITED', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc } = service(
      clock,
      () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' }
        })
    )
    await expect(svc.mint(IID, 'acme/infra', 'write')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
  })
})

describe('InstallationTokenService.mintLevels — per-capability levels (issue #457)', () => {
  const IID = 42n

  function levelsService(clock: FakeClock) {
    const bodies: Array<Record<string, unknown>> = []
    let calls = 0
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(clock.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    }
    const svc = new InstallationTokenService(cfg(), clock, fetchImpl)
    return { svc, bodies, calls: () => calls }
  }

  it('mints the asymmetric comment-tier shape; the uniform tiers stay uniform', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, bodies } = levelsService(clock)

    // comment tier: contents:read + issues/PR:write — the shape the uniform
    // (access × capabilities) `mint` form cannot express.
    const comment = await svc.mintLevels(IID, 'acme/tools', {
      contents: 'read',
      issues: 'write',
      pull_requests: 'write'
    })
    expect(bodies[0]!.permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      issues: 'write',
      pull_requests: 'write'
    })
    // The grant's access reports the CONTENTS level (what the git plane consumes).
    expect(comment.access).toBe('read')

    const read = await svc.mintLevels(IID, 'acme/read', {
      contents: 'read',
      issues: 'read',
      pull_requests: 'read'
    })
    expect(bodies[1]!.permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      issues: 'read',
      pull_requests: 'read'
    })
    expect(read.access).toBe('read')

    const write = await svc.mintLevels(IID, 'acme/write', {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write'
    })
    expect(bodies[2]!.permissions).toEqual({
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write'
    })
    expect(write.access).toBe('write')

    // No contents level minted at all ⇒ access degrades to 'read', never 'write'.
    const issuesOnly = await svc.mintLevels(IID, 'acme/tools', { issues: 'write' })
    expect(bodies[3]!.permissions).toEqual({ metadata: 'read', issues: 'write' })
    expect(issuesOnly.access).toBe('read')
  })

  it('distinct level maps are distinct cache entries; the same map (any key order) hits the cache', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, calls } = levelsService(clock)

    await svc.mintLevels(IID, 'acme/tools', { contents: 'read', issues: 'write' })
    await svc.mintLevels(IID, 'acme/tools', { contents: 'write', issues: 'write' }) // level differs ⇒ new entry
    await svc.mintLevels(IID, 'acme/tools', { contents: 'read' }) // cap set differs ⇒ new entry
    expect(calls()).toBe(3)

    // Same map, different insertion order ⇒ same key (caps are sorted).
    await svc.mintLevels(IID, 'acme/tools', { issues: 'write', contents: 'read' })
    expect(calls()).toBe(3)

    // The uniform `mint` collapses onto the mintLevels keyspace — no double mint
    // for the same effective shape.
    await svc.mint(IID, 'acme/tools', 'read', ['contents'])
    expect(calls()).toBe(3)
  })

  it('mints checks:write + pull_requests:read only through the CP-private reporter path', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const { svc, bodies } = levelsService(clock)

    const grant = await svc.mintChecks(IID, 'acme/tools', 777n)
    expect(grant.access).toBe('read')
    expect(bodies[0]).toEqual({
      repository_ids: [777],
      permissions: { metadata: 'read', checks: 'write', pull_requests: 'read' }
    })
  })

  it('installation invalidation prevents an older in-flight mint from repopulating the cache', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    let resolveFirst!: (response: Response) => void
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Promise<Response>((resolve) => (resolveFirst = resolve))
      return new Response(
        JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(clock.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    })
    const svc = new InstallationTokenService(cfg(), clock, fetchImpl)

    const first = svc.mintChecks(IID, 'acme/tools', 777n)
    await vi.waitFor(() => expect(calls).toBe(1))
    svc.invalidateInstallation(IID)
    const second = svc.mintChecks(IID, 'acme/tools', 777n)
    await expect(second).resolves.toMatchObject({ token: 'ghs_2' })

    resolveFirst(
      new Response(
        JSON.stringify({ token: 'ghs_stale', expires_at: new Date(clock.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(first).rejects.toBeInstanceOf(InstallationTokenInvalidatedError)
    // The stale completion did not overwrite the fresh post-invalidation entry.
    await expect(svc.mintChecks(IID, 'acme/tools', 777n)).resolves.toMatchObject({ token: 'ghs_2' })
    expect(calls).toBe(2)
  })
})

describe('GithubService.mintForAgent — capabilities forwarding (P2.5)', () => {
  it('forwards the wire capabilities through to the token mint permissions', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({ token: 'ghs_x', expires_at: new Date(clock.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      )
    }
    const installation = {
      id: 'row-1',
      orgId: 'org-a',
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      revokedAt: null,
      createdAt: new Date(0)
    }
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {
        get: async () => installation,
        liveByOrgAndAccount: async () => installation
      } as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    const agent = {
      id: 'agent-1',
      orgId: 'org-a',
      workspace: {
        mode: 'github',
        gitRepo: 'https://github.com/acme/infra',
        installationId: 'row-1',
        gitAccess: 'write'
      }
    } as never
    // The whole P2.5 chain hinges on this third argument actually reaching the
    // token request — a silent drop would 403 every `gh` write-back while all
    // token-service unit tests stay green.
    await svc.mintForAgent(agent, [], ['contents', 'issues', 'pull_requests', 'actions'])
    expect(bodies[0]!.permissions).toEqual({
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions: 'write',
      workflows: 'write'
    })
    // And absent capabilities keep the pre-P2.5 contents grant, with workflow
    // writes coupled to contents writes.
    await svc.mintForAgent(agent, [])
    expect(bodies[1]!.permissions).toEqual({ metadata: 'read', contents: 'write', workflows: 'write' })

    // §17.1 access floor: a caller may ask for LESS than the write tier, and the read it gets back
    // drops the coupled workflows write with it. 'write' is a no-op — the tier is already the ceiling.
    await svc.mintForAgent(agent, [], ['contents', 'issues'], undefined, 'read')
    expect(bodies[2]!.permissions).toEqual({ metadata: 'read', contents: 'read', issues: 'read' })
    await svc.mintForAgent(agent, [], ['contents'], undefined, 'write')
    expect(bodies).toHaveLength(3) // no new mint: it landed on the grant the absent-access ask cached
  })
})

describe('GithubService.mintForAgent — additional repos (issue #457)', () => {
  /** The agent's workspace: acme/infra through installation row-1, write access. */
  const AGENT = {
    id: 'agent-1',
    orgId: 'org-a',
    workspaceRepoId: 777n,
    workspace: {
      mode: 'github',
      gitRepo: 'https://github.com/acme/infra',
      installationId: 'row-1',
      gitAccess: 'write'
    }
  } as never

  const READ_WORKSPACE_AGENT = {
    id: 'agent-read',
    orgId: 'org-a',
    workspaceRepoId: 777n,
    workspace: {
      mode: 'github',
      gitRepo: 'https://github.com/acme/infra',
      installationId: 'row-1',
      gitAccess: 'read'
    }
  } as never

  const LEGACY_WORKSPACE_AGENT = {
    id: 'agent-legacy',
    orgId: 'org-a',
    workspace: {
      mode: 'github',
      gitRepo: 'https://github.com/acme/infra',
      installationId: 'row-1',
      gitAccess: 'write'
    }
  } as never

  const MANUAL_WORKSPACE_AGENT = {
    id: 'agent-manual',
    orgId: 'org-a',
    workspace: { mode: 'github', gitRepo: 'https://github.com/acme/infra' }
  } as never

  const SCRATCH_AGENT = {
    id: 'agent-scratch',
    orgId: 'org-a',
    workspace: { mode: 'scratch' }
  } as never

  function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
    return {
      id: 'row-1',
      orgId: 'org-a' as never,
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: {},
      suspendedAt: null,
      revokedAt: null,
      createdAt: new Date(0),
      ...over
    }
  }

  function grantRow(over: Partial<AgentRepoAuthorizationRecord> = {}): AgentRepoAuthorizationRecord {
    return {
      id: 'ra-1',
      agentId: 'agent-1' as never,
      provider: 'github',
      repoId: 111n,
      repoFullName: 'Acme/Tools', // stored as GitHub cases it — may differ from the request
      access: 'comment',
      createdAt: new Date(0),
      createdBy: null,
      ...over
    }
  }

  /**
   * Full fake graph: a URL-routed GitHub fetch (token mints + repo lookups),
   * a by-account installation table, and in-memory grant rows. `mintBodies`
   * records only ACTUAL repo-scoped token mints (by name OR numeric id); the
   * slow path's metadata token rides the same endpoint but has neither
   * narrowing key.
   */
  function harness(opts: {
    rows?: AgentRepoAuthorizationRecord[]
    installationsByAccount?: Record<string, GithubInstallationRecord>
    /** GET /repos/{owner}/{repo} answers, keyed lowercase; missing ⇒ 404. */
    repoRefs?: Record<string, { id: number; full_name: string }>
    withRepoAuths?: boolean
  }) {
    const clock = new FakeClock(1_700_000_000_000)
    const byAccount = opts.installationsByAccount ?? { acme: installation() }
    const mintBodies: Array<Record<string, unknown>> = []
    const repoLookups: string[] = []
    const accountLookups: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('/access_tokens')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.repositories || body.repository_ids) mintBodies.push(body)
        return Response.json(
          { token: `ghs_${mintBodies.length}`, expires_at: new Date(clock.now() + 3_600_000).toISOString() },
          { status: 201 }
        )
      }
      const repoPath = /\/repos\/([^/]+\/[^/]+)$/.exec(url)
      if (repoPath) {
        repoLookups.push(repoPath[1]!)
        const hit = opts.repoRefs?.[repoPath[1]!.toLowerCase()]
        if (!hit) return Response.json({ message: 'Not Found' }, { status: 404 })
        return Response.json({ ...hit, private: true }, { status: 200 })
      }
      throw new Error(`unexpected github call: ${url}`)
    }
    const listForAgent = vi.fn(async () => opts.rows ?? [])
    const updateFullName = vi.fn(async () => {})
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {
        get: async (id: string) => (id === 'row-1' ? (byAccount['acme'] ?? null) : null),
        liveByOrgAndAccount: async (_orgId: string, account: string) => {
          accountLookups.push(account)
          return byAccount[account] ?? null
        }
      } as never,
      installState: { put: async () => {}, consume: async () => true },
      ...(opts.withRepoAuths === false ? {} : { repoAuths: { listForAgent, updateFullName } as never }),
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    return { svc, mintBodies, repoLookups, accountLookups, listForAgent, updateFullName }
  }

  const CONTENTS: readonly GitCredCapability[] = ['contents'] // the git plane's ask

  it('a requestedRepo equal to the workspace label mints by its rename-proof repo id', async () => {
    const { svc, mintBodies, listForAgent } = harness({ rows: [grantRow()] })
    const grant = await svc.mintForAgent(AGENT, [], CONTENTS, 'ACME/Infra')
    // Uniform workspace shape at the agent's gitAccess — grant rows and
    // repository metadata are never consulted.
    expect(grant).toMatchObject({ repoFullName: 'acme/infra', access: 'write' })
    expect(mintBodies[0]).toMatchObject({
      repository_ids: [777],
      permissions: { metadata: 'read', contents: 'write', workflows: 'write' }
    })
    expect(listForAgent).not.toHaveBeenCalled()
  })

  it('recognizes a renamed workspace by repo id and echoes the requested name', async () => {
    const { svc, mintBodies, repoLookups } = harness({
      rows: [],
      repoRefs: { 'acme/infra-renamed': { id: 777, full_name: 'acme/infra-renamed' } }
    })

    const grant = await svc.mintForAgent(AGENT, [], CONTENTS, 'acme/infra-renamed')

    expect(grant).toMatchObject({
      repoFullName: 'acme/infra-renamed',
      access: 'write'
    })
    expect(repoLookups).toEqual(['acme/infra-renamed'])
    expect(mintBodies[0]).toMatchObject({ repository_ids: [777] })
  })

  it('keeps a legacy workspace name-scoped until workspaceRepoId is repaired', async () => {
    const { svc, mintBodies } = harness({ rows: [] })
    await svc.mintForAgent(LEGACY_WORKSPACE_AGENT, [], CONTENTS)
    expect(mintBodies[0]).toMatchObject({ repositories: ['infra'] })
  })

  it('uses an explicit workspace-repo grant for CP effects without enabling manual-workspace git credentials', async () => {
    const { svc } = harness({
      rows: [grantRow({ agentId: 'agent-manual' as never, repoId: 100n, repoFullName: 'acme/infra', access: 'write' })],
      repoRefs: { 'acme/infra': { id: 100, full_name: 'acme/infra' } }
    })

    await expect(svc.resolveAgentRepoAuthorization(MANUAL_WORKSPACE_AGENT, 100n, 'acme/infra')).resolves.toMatchObject({
      kind: 'additional',
      repoId: 100n,
      repoFullName: 'acme/infra',
      access: 'write'
    })
    await expect(svc.mintForAgent(MANUAL_WORKSPACE_AGENT, [], CONTENTS)).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      retryable: false
    })
  })

  it('mints a named explicit grant for scratch but never invents a default repo', async () => {
    const { svc, mintBodies } = harness({
      rows: [grantRow({ agentId: 'agent-scratch' as never, repoId: 111n, repoFullName: 'acme/tools', access: 'write' })]
    })

    await expect(svc.mintForAgent(SCRATCH_AGENT, [], CONTENTS)).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
      retryable: false
    })
    const grant = await svc.mintForAgent(SCRATCH_AGENT, [], CONTENTS, 'acme/tools')
    expect(grant).toMatchObject({ repoFullName: 'acme/tools', access: 'write' })
    expect(mintBodies[0]).toMatchObject({
      repository_ids: [111],
      permissions: { metadata: 'read', contents: 'write', workflows: 'write' }
    })
  })

  it('fast path: a name-matched grant mints by repoId at the tier clamp, echoes the requested name', async () => {
    const { svc, mintBodies, repoLookups, accountLookups } = harness({ rows: [grantRow()] })

    // Git plane (contents-only ask): comment tier clamps contents to read; the
    // tier's issues/PR levels are NOT minted — only requested classes are.
    // Mint binds to the row's NUMERIC repoId (rename-immune), never the name;
    // the grant ECHOES the requested name (not the row's stored casing) so the
    // daemon's identity guard is a clean equality check.
    const grant = await svc.mintForAgent(AGENT, [], CONTENTS, 'acme/tools')
    // …and reports that numeric id back, which is what a provider-qualified grant echoes.
    expect(grant).toMatchObject({ repoFullName: 'acme/tools', access: 'read', repoId: 111n })
    expect(mintBodies[0]).toMatchObject({
      repository_ids: [111],
      permissions: { metadata: 'read', contents: 'read' }
    })
    expect(mintBodies[0]).not.toHaveProperty('repositories')
    // The full capability ask mints the whole asymmetric comment shape.
    await svc.mintForAgent(AGENT, [], ['contents', 'issues', 'pull_requests', 'actions'], 'acme/tools')
    expect(mintBodies[1]!.permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      issues: 'write',
      pull_requests: 'write'
    })
    expect(mintBodies[1]!.permissions).not.toHaveProperty('actions')
    // Installation resolution went by the REQUESTED owner; no /repos lookup (fast path).
    expect(accountLookups).toEqual(['acme', 'acme'])
    expect(repoLookups).toEqual([])
  })

  it('the hook-reply poster mints issues/PR write with NO contents even for a read-only workspace', async () => {
    const { svc, mintBodies, listForAgent } = harness({ rows: [] })

    const first = await svc.mintForHookReply(READ_WORKSPACE_AGENT, 'acme/infra', 777n, [])
    const cached = await svc.mintForHookReply(READ_WORKSPACE_AGENT, 'acme/infra', 777n, [])
    const refreshed = await svc.mintForHookReply(READ_WORKSPACE_AGENT, 'acme/infra', 777n, [], true)

    expect(mintBodies[0]).toEqual({
      repository_ids: [777],
      permissions: { metadata: 'read', issues: 'write', pull_requests: 'write' }
    })
    expect(first.token).toBe(cached.token)
    expect(refreshed.token).not.toBe(first.token)
    expect(mintBodies).toHaveLength(2)
    expect(listForAgent).not.toHaveBeenCalled()
  })

  it('a general issues/PR ask still follows an additional repo comment-tier grant', async () => {
    const { svc, mintBodies } = harness({ rows: [grantRow({ access: 'comment' })] })

    await svc.mintForAgent(AGENT, [], ['issues', 'pull_requests'], 'acme/tools')

    expect(mintBodies[0]!.permissions).toEqual({ metadata: 'read', issues: 'write', pull_requests: 'write' })
    expect(mintBodies[0]).not.toHaveProperty('repositories')
  })

  it('slow path (rename): resolves the unknown name by numeric id, refreshes the stored name, mints by id', async () => {
    const { svc, mintBodies, updateFullName } = harness({
      rows: [grantRow({ id: 'ra-2', repoId: 222n, repoFullName: 'acme/old-name', access: 'write' })],
      repoRefs: { 'acme/new-name': { id: 222, full_name: 'acme/new-name' } }
    })
    const grant = await svc.mintForAgent(AGENT, [], CONTENTS, 'acme/new-name')
    expect(grant).toMatchObject({ repoFullName: 'acme/new-name', access: 'write' })
    // Scoped by the row's numeric id (222), not any name the daemon supplied.
    expect(mintBodies[0]).toMatchObject({
      repository_ids: [222],
      permissions: { metadata: 'read', contents: 'write', workflows: 'write' }
    })
    // Best-effort refresh of the stored DISPLAY name to GitHub's canonical.
    expect(updateFullName).toHaveBeenCalledWith('ra-2', 'acme/new-name')
  })

  it('GitHub rename redirect: grant ECHOES the requested (stale) name, not canonical — daemon guard mustn’t false-reject', async () => {
    // A stale clone still has remote acme/old-name; the row already stores the
    // canonical acme/new-name (picker/refresh). GitHub redirects old→new, so
    // repoRefFor(old) resolves to the new canonical + matching repoId 222.
    const { svc, mintBodies } = harness({
      rows: [grantRow({ id: 'ra-3', repoId: 222n, repoFullName: 'acme/new-name', access: 'write' })],
      repoRefs: { 'acme/old-name': { id: 222, full_name: 'acme/new-name' } }
    })
    const grant = await svc.mintForAgent(AGENT, [], CONTENTS, 'acme/old-name')
    // The grant must report what the daemon ASKED (acme/old-name) so its
    // identity guard passes — reporting the canonical acme/new-name would loop
    // it on "control plane too old". The token is still correct (minted by id).
    expect(grant.repoFullName).toBe('acme/old-name')
    expect(mintBodies[0]).toMatchObject({ repository_ids: [222] })
  })

  it('no grant rows — or no repoAuths wiring at all — denies SCOPE_DENIED, non-retryable', async () => {
    const scope = { code: 'SCOPE_DENIED', retryable: false }
    const none = harness({ rows: [] })
    await expect(none.svc.mintForAgent(AGENT, [], CONTENTS, 'acme/tools')).rejects.toMatchObject(scope)
    // Older harnesses without the dep behave like "no rows" (never a crash).
    const unwired = harness({ withRepoAuths: false })
    await expect(unwired.svc.mintForAgent(AGENT, [], CONTENTS, 'acme/tools')).rejects.toMatchObject(scope)
  })

  it('rows that do not match deny SCOPE_DENIED — even when the owner has no installation (no coverage oracle)', async () => {
    const scope = { code: 'SCOPE_DENIED', retryable: false }
    // Slow path resolves a repoId no row grants ⇒ SCOPE.
    const wrongId = harness({
      rows: [grantRow()],
      repoRefs: { 'acme/unrelated': { id: 555, full_name: 'acme/unrelated' } }
    })
    await expect(wrongId.svc.mintForAgent(AGENT, [], CONTENTS, 'acme/unrelated')).rejects.toMatchObject(scope)
    // Unknown owner, no name match: the probe must not learn whether an
    // installation covers it — SCOPE, not LEASE.
    const noOwner = harness({ rows: [grantRow()] })
    await expect(noOwner.svc.mintForAgent(AGENT, [], CONTENTS, 'evil/repo')).rejects.toMatchObject(scope)
  })

  it('a name-matched grant without a live (or with a suspended) installation denies LEASE_DENIED', async () => {
    const gone = harness({ rows: [grantRow()], installationsByAccount: {} })
    await expect(gone.svc.mintForAgent(AGENT, [], CONTENTS, 'acme/tools')).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: false
    })
    const suspended = harness({
      rows: [grantRow()],
      installationsByAccount: { acme: installation({ suspendedAt: new Date(1) }) }
    })
    await expect(suspended.svc.mintForAgent(AGENT, [], CONTENTS, 'acme/tools')).rejects.toMatchObject({
      code: 'LEASE_DENIED'
    })
  })
})

describe('GithubService.mintReviewForAgent — persisted installation permission', () => {
  function reviewHarness(permissions: Record<string, string>) {
    const clock = new FakeClock(1_700_000_000_000)
    const mintBodies: Array<Record<string, unknown>> = []
    const installation = {
      id: 'row-1',
      orgId: 'org-a',
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      revokedAt: null,
      permissions,
      createdAt: new Date(0)
    }
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('/access_tokens')) {
        mintBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json(
          { token: `ghs_${mintBodies.length}`, expires_at: new Date(clock.now() + 3_600_000).toISOString() },
          { status: 201 }
        )
      }
      if (url.endsWith('/repos/acme/infra')) {
        return Response.json({ id: 123, full_name: 'acme/infra', private: true })
      }
      throw new Error(`unexpected github call: ${url}`)
    }
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: { liveByOrgAndAccount: async () => installation } as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    const agent = {
      id: 'agent-1',
      orgId: 'org-a',
      workspaceRepoId: 123n,
      workspace: {
        mode: 'github',
        gitRepo: 'https://github.com/acme/infra',
        installationId: 'row-1',
        gitAccess: 'write'
      }
    } as never
    return { svc, agent, mintBodies }
  }

  it('fails closed for a legacy unknown permission snapshot', async () => {
    const { svc, agent, mintBodies } = reviewHarness({})
    await expect(svc.mintReviewForAgent(agent, 123n, 'acme/infra', 'COMMENT')).rejects.toMatchObject({
      code: 'LEASE_DENIED',
      retryable: false
    })
    // Repo identity metadata may be resolved, but no review-purpose token is minted.
    expect(mintBodies).toHaveLength(1)
  })

  it('mints the review-purpose token only after exact pull_requests:write', async () => {
    const { svc, agent, mintBodies } = reviewHarness({ metadata: 'read', pull_requests: 'write' })
    await expect(svc.mintReviewForAgent(agent, 123n, 'acme/infra', 'APPROVE')).resolves.toMatchObject({
      token: 'ghs_2'
    })
    expect(mintBodies[1]).toMatchObject({
      repository_ids: [123],
      permissions: { metadata: 'read', pull_requests: 'write' }
    })
  })

  // M6 auto-merge: arming merges code, so only write tier + accepted pull_requests:write qualify.
  it('mints the auto-merge token with pull_requests + contents write for a write-tier agent', async () => {
    const { svc, agent, mintBodies } = reviewHarness({ pull_requests: 'write', contents: 'write' })
    await expect(svc.mintAutoMergeForAgent(agent, 123n, 'acme/infra')).resolves.toMatchObject({ token: 'ghs_2' })
    expect(mintBodies[1]).toMatchObject({
      repository_ids: [123],
      permissions: { pull_requests: 'write', contents: 'write' }
    })
    await expect(svc.canArmAutoMerge(agent, 123n, 'acme/infra')).resolves.toBe(true)
  })

  it('refuses auto-merge below write tier and on a missing installation grant, and canArmAutoMerge mirrors it', async () => {
    const readTier = reviewHarness({ pull_requests: 'write', contents: 'write' })
    const readAgent = {
      ...(readTier.agent as Record<string, unknown>),
      workspace: {
        mode: 'github',
        gitRepo: 'https://github.com/acme/infra',
        installationId: 'row-1',
        gitAccess: 'read'
      }
    } as never
    await expect(readTier.svc.mintAutoMergeForAgent(readAgent, 123n, 'acme/infra')).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    await expect(readTier.svc.canArmAutoMerge(readAgent, 123n, 'acme/infra')).resolves.toBe(false)

    const noGrant = reviewHarness({ pull_requests: 'read' })
    await expect(noGrant.svc.mintAutoMergeForAgent(noGrant.agent, 123n, 'acme/infra')).rejects.toMatchObject({
      code: 'LEASE_DENIED'
    })
    await expect(noGrant.svc.canArmAutoMerge(noGrant.agent, 123n, 'acme/infra')).resolves.toBe(false)
  })
})

describe('GithubService.refreshInstallationFacts', () => {
  it('re-pulls and upserts only an already-claimed installation, then wakes dependents', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const claimed = {
      id: 'row-1',
      orgId: OrgId('org-a'),
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      revokedAt: null,
      permissions: {},
      createdAt: new Date(0)
    } as GithubInstallationRecord
    const refreshed = { ...claimed, permissions: { checks: 'write' } }
    const upsertFromGithub = vi.fn(async () => refreshed)
    const onInstallationFactsChanged = vi.fn()
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/app/installations/42')
      return Response.json({
        id: 42,
        account: { login: 'acme', type: 'Organization' },
        repository_selection: 'all',
        suspended_at: null,
        permissions: { checks: 'write' }
      })
    })
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {
        getByInstallationId: vi.fn(async () => claimed),
        upsertFromGithub,
        markRevokedByInstallationId: vi.fn()
      } as never,
      installState: { put: async () => {}, consume: async () => true },
      onInstallationFactsChanged,
      pepper: 'p'.repeat(32),
      fetchImpl
    })

    await expect(svc.refreshInstallationFacts(42n)).resolves.toEqual(refreshed)

    expect(upsertFromGithub).toHaveBeenCalledWith(
      'org-a',
      expect.objectContaining({ installationId: 42n, permissions: { checks: 'write' } })
    )
    expect(onInstallationFactsChanged).toHaveBeenCalledWith(42n, 'org-a')
  })

  it('never auto-claims an unknown installation id', async () => {
    const fetchImpl = vi.fn()
    const svc = new GithubService({
      cfg: cfg(),
      clock: new FakeClock(1_700_000_000_000),
      installations: { getByInstallationId: vi.fn(async () => null) } as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })

    await expect(svc.refreshInstallationFacts(42n)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes a stale permission snapshot before minting a Checks token', async () => {
    const clock = new FakeClock(1_700_000_000_000)
    const claimed = {
      id: 'row-1',
      orgId: OrgId('org-a'),
      installationId: 42n,
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspendedAt: null,
      revokedAt: null,
      // checks:write alone is insufficient: the reporter also needs exact
      // pull_requests:read for the live commit -> PR association barrier.
      permissions: { checks: 'write' },
      createdAt: new Date(0)
    } as GithubInstallationRecord
    const refreshed = { ...claimed, permissions: { checks: 'write', pull_requests: 'read' } }
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/app/installations/42')) {
        return Response.json({
          id: 42,
          account: { login: 'acme', type: 'Organization' },
          repository_selection: 'all',
          suspended_at: null,
          permissions: { checks: 'write', pull_requests: 'read' }
        })
      }
      if (url.endsWith('/app/installations/42/access_tokens')) {
        return Response.json(
          { token: 'ghs_checks', expires_at: new Date(clock.now() + 3_600_000).toISOString() },
          { status: 201 }
        )
      }
      throw new Error(`unexpected github call: ${url}`)
    })
    const svc = new GithubService({
      cfg: cfg(),
      clock,
      installations: {
        getByInstallationId: vi.fn(async () => claimed),
        upsertFromGithub: vi.fn(async () => refreshed),
        markRevokedByInstallationId: vi.fn()
      } as never,
      installState: { put: async () => {}, consume: async () => true },
      pepper: 'p'.repeat(32),
      fetchImpl
    })
    vi.spyOn(svc, 'resolveAgentRepoAuthorization').mockResolvedValue({
      kind: 'workspace',
      repoId: 123n,
      repoFullName: 'acme/repo',
      access: 'write',
      installation: claimed
    })

    await expect(svc.mintChecksForAgent({ id: 'agent-1' } as never, 123n, 'acme/repo')).resolves.toMatchObject({
      cred: { token: 'ghs_checks' },
      resolved: { installation: { permissions: { checks: 'write', pull_requests: 'read' } } }
    })
  })
})

describe('TokenBucket', () => {
  it('caps bursts per key and refills over time', () => {
    const clock = new FakeClock(0)
    const bucket = new TokenBucket(3, 1, clock) // 3 burst, 1/s refill
    expect(bucket.take('d1')).toBe(true)
    expect(bucket.take('d1')).toBe(true)
    expect(bucket.take('d1')).toBe(true)
    expect(bucket.take('d1')).toBe(false)
    expect(bucket.take('d2')).toBe(true) // independent key
    clock.advance(2000)
    expect(bucket.take('d1')).toBe(true)
    expect(bucket.take('d1')).toBe(true)
    expect(bucket.take('d1')).toBe(false)
  })
})
