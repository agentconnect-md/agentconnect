// Agents' dedicated GitHub Apps without Docker or network: per-installation signing and the manifest flow.
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { decodeJwt } from 'jose'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { OrgId } from '../domain/ids.js'
import type { GithubAppRecord, GithubInstallationRecord } from '../persistence/ports.js'
import { githubAppConfigFromParts, type GithubAppConfig } from './config.js'
import { GithubAppRegistry } from './app-registry.js'
import { GithubAppRegistrationError, GithubAppsService } from './apps.service.js'
import { InstallationTokenService } from './installation-token.service.js'

const deploymentKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const reviewKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const REVIEW_KEY_B64 = Buffer.from(reviewKey.export({ type: 'pkcs1', format: 'pem' }) as string).toString('base64')

const DEPLOYMENT: GithubAppConfig = { appId: 1000, slug: 'example-app', jwtIssuer: '1000', privateKey: deploymentKey }
const ORG = OrgId('org-a')

function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: 'row-1',
    orgId: ORG,
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

function app(over: Partial<GithubAppRecord> = {}): GithubAppRecord {
  return {
    id: 'app-review',
    orgId: ORG,
    agentId: 'agent-1',
    appId: 2000n,
    slug: 'example-review',
    clientId: null,
    botUserId: 77n,
    retiredAt: null,
    createdAt: new Date(0),
    ...over
  }
}

describe('GithubAppRegistry', () => {
  it('signs a deployment-App installation with nothing and a registered one with its own key, cached per App', async () => {
    const getUnscoped = vi.fn(async (id: string) => (id === 'app-review' ? app() : null))
    const get = vi.fn(async () => REVIEW_KEY_B64)
    const registry = new GithubAppRegistry({
      apps: { getUnscoped },
      secrets: { get },
      installations: {
        getByInstallationId: async (id: bigint) =>
          id === 42n
            ? installation()
            : id === 43n
              ? installation({ installationId: 43n, githubAppId: 'app-review' })
              : null
      }
    })
    await expect(registry.configForInstallation(42n)).resolves.toBeUndefined()
    const cfg = await registry.configForInstallation(43n)
    expect(cfg).toMatchObject({ appId: 2000, slug: 'example-review', jwtIssuer: '2000' })
    await registry.configForInstallation(43n)
    expect(getUnscoped).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)

    registry.invalidate('app-review')
    await registry.configForInstallation(43n)
    expect(getUnscoped).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the installation names an App that is gone', async () => {
    const registry = new GithubAppRegistry({
      apps: { getUnscoped: async () => null },
      secrets: { get: async () => null },
      installations: { getByInstallationId: async () => installation({ githubAppId: 'app-gone' }) }
    })
    await expect(registry.configForInstallation(43n)).rejects.toThrow(/not registered/)
  })
})

describe('InstallationTokenService with a per-installation signer', () => {
  it('mints with the JWT of the App an installation belongs to', async () => {
    const issuers: Record<string, string> = {}
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      const id = /installations\/(\d+)\/access_tokens/.exec(url)![1]!
      issuers[id] = String(decodeJwt(auth.replace(/^Bearer /, '')).iss)
      return Response.json(
        { token: `ghs_${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 }
      )
    }
    const review = githubAppConfigFromParts({ appId: 2000, slug: 'example-review', privateKeyB64: REVIEW_KEY_B64 })
    const tokens = new InstallationTokenService(
      DEPLOYMENT,
      new FakeClock(Date.now()),
      fetchImpl,
      undefined,
      async (id) => (id === 43n ? review : undefined)
    )
    await tokens.mint(42n, 'acme/tools', 'read')
    await tokens.mint(43n, 'acme/tools', 'read')
    expect(issuers).toEqual({ '42': '1000', '43': '2000' })
  })
})

describe('GithubAppsService', () => {
  const REVIEW_PEM = Buffer.from(REVIEW_KEY_B64, 'base64').toString('utf8')

  function harness(opts: { bindable?: boolean } = {}) {
    const rows: GithubAppRecord[] = []
    const claimed: Array<{ orgId: string; installationId: bigint; githubAppId?: string | null }> = []
    const revoked: bigint[] = []
    const secrets = new Map<string, string>()
    const nonces = new Set<string>()
    const invalidate = vi.fn()
    const appsChanged = vi.fn()
    const changed: bigint[] = []
    const calls: string[] = []
    const clock = new FakeClock(1_800_000_000_000)
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/app-manifests/code-1/conversions')) {
        return Response.json({ id: 2000, slug: 'example-review', client_id: 'Iv1', pem: REVIEW_PEM }, { status: 201 })
      }
      if (url.includes('/app/installations')) {
        return Response.json([
          { id: 43, account: { login: 'acme', type: 'Organization' }, repository_selection: 'all', suspended_at: null }
        ])
      }
      throw new Error(`unexpected github call: ${url}`)
    }
    const svc = new GithubAppsService({
      apps: {
        createForAgent: async ({ agentId, ...input }) => {
          if (opts.bindable === false) return null
          const row = app({ ...input, agentId })
          rows.push(row)
          return row
        },
        get: async (_org, id) => rows.find((r) => r.id === id) ?? null,
        getUnscoped: async (id) => rows.find((r) => r.id === id) ?? null,
        getForAgent: async (_org, agentId) => rows.find((r) => r.agentId === agentId) ?? null,
        listForOrg: async () => rows,
        retire: async (_org, id, at) => {
          const row = rows.find((r) => r.id === id && r.retiredAt === null)
          if (!row) return false
          Object.assign(row, { retiredAt: at, agentId: null })
          return true
        },
        reapRetired: async (before) => {
          const gone = rows.filter((r) => r.retiredAt !== null && r.retiredAt < before)
          for (const r of gone) rows.splice(rows.indexOf(r), 1)
          return gone.map((r) => ({ id: r.id, orgId: r.orgId, installationIds: [43n] }))
        },
        delete: async (_org, id) => {
          const i = rows.findIndex((r) => r.id === id)
          if (i < 0) return false
          rows.splice(i, 1)
          return true
        }
      },
      secrets: { put: async (_o, id, v) => void secrets.set(id, v), get: async (_o, id) => secrets.get(id) ?? null },
      installations: {
        upsertFromGithub: async (orgId, facts, githubAppId) => {
          claimed.push({ orgId, installationId: facts.installationId, githubAppId })
          return installation({ orgId, installationId: facts.installationId, githubAppId })
        },
        listClaimsForOrg: async () => [
          ...claimed.map((c) => installation({ installationId: c.installationId, githubAppId: c.githubAppId })),
          // claimed earlier, gone on GitHub
          installation({
            installationId: 99n,
            githubAppId: rows[0]?.id ?? null,
            revokedAt: revoked.includes(99n) ? new Date(1) : null
          })
        ],
        markRevokedByInstallationId: async (id) => void revoked.push(id)
      },
      states: {
        put: async (nonce) => void nonces.add(nonce),
        consume: async (nonce) => nonces.delete(nonce)
      },
      registry: { invalidate },
      botUserId: async (slug) => (slug === 'example-review' ? 77 : -1),
      pepper: 'p'.repeat(32),
      clock,
      publicCpUrl: 'https://api.example.test/',
      webAppUrl: 'https://console.example.test',
      onInstallationChanged: async (id) => void changed.push(id),
      onAppsChanged: appsChanged,
      fetchImpl
    })
    return { svc, rows, claimed, revoked, secrets, invalidate, appsChanged, changed, calls, clock }
  }

  async function started(h: ReturnType<typeof harness>) {
    const form = await h.svc.startManifest(ORG, { id: 'agent-1', name: 'reviewer' }, 'acme')
    return { form, state: new URL(form.action).searchParams.get('state')! }
  }

  it('starts a manifest under the owner, naming the pre-allocated App in its setup URL', async () => {
    const h = harness()
    const { form } = await started(h)
    const action = new URL(form.action)
    expect(`${action.origin}${action.pathname}`).toBe('https://github.com/organizations/acme/settings/apps/new')
    expect(form.manifest).toMatchObject({
      name: 'reviewer-acme',
      url: 'https://console.example.test',
      redirect_url: 'https://api.example.test/v1/github/apps/manifest/callback',
      setup_on_update: true,
      public: false
    })
    expect(form.manifest.setup_url).toMatch(
      /^https:\/\/api\.example\.test\/v1\/github\/apps\/[0-9a-f-]{36}\/setup\/callback$/
    )
    expect(form.manifest).not.toHaveProperty('hook_attributes')
    await expect(h.svc.startManifest(ORG, { id: 'agent-1', name: 'reviewer' }, 'bad/owner')).rejects.toBeInstanceOf(
      GithubAppRegistrationError
    )
  })

  it('converts the code once, binds the App to its agent and seals its key', async () => {
    const h = harness()
    const { form, state } = await started(h)
    const done = await h.svc.completeManifest(state, 'code-1')
    expect(done).toEqual({ app: h.rows[0], installUrl: 'https://github.com/apps/example-review/installations/new' })
    expect(h.rows[0]).toMatchObject({ agentId: 'agent-1', appId: 2000n, slug: 'example-review', botUserId: 77n })
    expect(form.manifest.setup_url).toContain(`/apps/${h.rows[0]!.id}/setup/callback`)
    expect(h.secrets.get(h.rows[0]!.id)).toBe(REVIEW_KEY_B64)
    expect(h.invalidate).toHaveBeenCalledWith(h.rows[0]!.id)
    expect(h.appsChanged).toHaveBeenCalledWith(ORG)
    // One-shot: a replayed or forged state converts nothing.
    await expect(h.svc.completeManifest(state, 'code-1')).resolves.toBeNull()
    await expect(h.svc.completeManifest(`${state}x`, 'code-1')).resolves.toBeNull()
    expect(h.calls.filter((c) => c.includes('/conversions'))).toHaveLength(1)
  })

  it('reports an App it could not bind without storing its key', async () => {
    const h = harness({ bindable: false })
    const { state } = await started(h)
    await expect(h.svc.completeManifest(state, 'code-1')).resolves.toEqual({ orphanedSlug: 'example-review' })
    expect(h.secrets.size).toBe(0)
    expect(h.appsChanged).not.toHaveBeenCalled()
  })

  it('syncs the roster on a setup redirect, at most once per interval', async () => {
    const h = harness()
    await h.svc.completeManifest((await started(h)).state, 'code-1')
    const id = h.rows[0]!.id
    await expect(h.svc.completeSetup(id)).resolves.toMatchObject({ id, agentId: 'agent-1' })
    expect(h.claimed).toEqual([{ orgId: ORG, installationId: 43n, githubAppId: id }])
    expect(h.revoked).toEqual([99n])
    expect(h.changed).toEqual([43n, 99n])
    await h.svc.completeSetup(id)
    expect(h.claimed).toHaveLength(1)
    h.clock.advance(10_000)
    await h.svc.completeSetup(id)
    expect(h.claimed).toHaveLength(2)
    await expect(h.svc.completeSetup('00000000-0000-4000-8000-000000000000')).resolves.toBeNull()
  })

  it('remove retires the App, which keeps signing until the reaper deletes it after the grace', async () => {
    const h = harness()
    await h.svc.completeManifest((await started(h)).state, 'code-1')
    const id = h.rows[0]!.id
    h.appsChanged.mockClear()
    h.invalidate.mockClear()
    await expect(h.svc.remove(ORG, id)).resolves.toBe(true)
    expect(h.rows[0]).toMatchObject({ id, agentId: null, retiredAt: new Date(h.clock.now()) })
    expect(h.invalidate).not.toHaveBeenCalled()
    await expect(h.svc.remove(ORG, id)).resolves.toBe(false)

    await expect(h.svc.reap()).resolves.toBe(0)
    h.clock.advance(60 * 60 * 1000 + 1)
    await expect(h.svc.reap()).resolves.toBe(1)
    expect(h.rows).toEqual([])
    expect(h.invalidate).toHaveBeenCalledWith(id)
    expect(h.changed).toContain(43n)
    expect(h.appsChanged).toHaveBeenCalledWith(ORG)
  })
})
