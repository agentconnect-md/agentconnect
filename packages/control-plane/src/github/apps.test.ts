// Organization GitHub Apps without Docker or network: per-installation signing, the manifest flow, coverage and the switch.
import { generateKeyPairSync } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { decodeJwt } from 'jose'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { OrgId } from '../domain/ids.js'
import type { AgentRecord, GithubAppRecord, GithubInstallationRecord } from '../persistence/ports.js'
import { githubAppConfigFromParts, type GithubAppConfig } from './config.js'
import { GithubAppRegistry } from './app-registry.js'
import { GithubAppRegistrationError, GithubAppsService, type AgentGithubScope } from './apps.service.js'
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
  const AGENT = { id: 'agent-1', orgId: ORG, name: 'reviewer', githubAppId: null } as unknown as AgentRecord

  function harness(
    opts: {
      scope?: AgentGithubScope
      installations?: GithubInstallationRecord[]
      covered?: (owner: string, repo: string) => boolean
      switchResult?: Awaited<ReturnType<NonNullable<GithubAppsService['switch']>>> | { ok: false; kind: string }
    } = {}
  ) {
    const rows: GithubAppRecord[] = []
    const secrets = new Map<string, string>()
    const nonces = new Set<string>()
    const invalidate = vi.fn()
    const appsChanged = vi.fn()
    const switches: Array<{ from: string | null; to: string | null }> = []
    const clock = new FakeClock(1_800_000_000_000)
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/app-manifests/code-1/conversions')) {
        return Response.json(
          { id: 2000, slug: 'example-review', client_id: 'Iv1', pem: REVIEW_PEM, webhook_secret: 'whsec' },
          { status: 201 }
        )
      }
      if (url.includes('/app/installations')) return Response.json([])
      throw new Error(`unexpected github call: ${url}`)
    }
    const installs = opts.installations ?? [installation({ accountLogin: 'acme', accountType: 'Organization' })]
    const svc = new GithubAppsService({
      apps: {
        create: async (input) => {
          const row = app({ ...input, agentId: null })
          rows.push(row)
          return row
        },
        get: async (_org, id) => rows.find((r) => r.id === id) ?? null,
        getUnscoped: async (id) => rows.find((r) => r.id === id) ?? null,
        getByAppId: async (appId) => rows.find((r) => r.appId === appId) ?? null,
        listForOrg: async () => rows,
        switchAgent: async (input) => {
          switches.push({ from: input.from, to: input.to })
          return (opts.switchResult as never) ?? { ok: true }
        },
        deleteFree: async (_org, id) => {
          const i = rows.findIndex((r) => r.id === id && r.agentId === null)
          if (i < 0) return false
          rows.splice(i, 1)
          return true
        }
      },
      secrets: {
        put: async (_o, id, v) => void secrets.set(id, v),
        get: async (_o, id) => secrets.get(id) ?? null,
        listWebhooks: async () => []
      },
      installations: {
        upsertFromGithub: async () => installation(),
        listClaimsForOrg: async () => installs,
        markRevokedByInstallationId: async () => undefined,
        liveByOrgAndAccount: async (_org, login, githubAppId = null) =>
          installs.find(
            (i) => i.accountLogin.toLowerCase() === login.toLowerCase() && (i.githubAppId ?? null) === githubAppId
          ) ?? null
      },
      states: { put: async (nonce) => void nonces.add(nonce), consume: async (nonce) => nonces.delete(nonce) },
      registry: { invalidate },
      botUserId: async () => 77,
      agentScope: async () =>
        opts.scope ?? { repositories: [{ fullName: 'acme/tools', kind: 'workspace' }], accounts: [] },
      covers: async (_i, owner, repo) => (opts.covered ?? (() => true))(owner, repo),
      pepper: 'p'.repeat(32),
      clock,
      publicCpUrl: 'https://api.example.test/',
      publicRelayUrl: 'https://relay.example.test',
      webAppUrl: 'https://console.example.test',
      onAppsChanged: appsChanged,
      fetchImpl
    })
    return { svc, rows, secrets, invalidate, appsChanged, switches }
  }

  it("starts a manifest owned by the account the agent's repositories live on, with the built-in App's webhook URL", async () => {
    const h = harness()
    const form = await h.svc.startManifest(ORG, AGENT)
    const action = new URL(form.action)
    expect(`${action.origin}${action.pathname}`).toBe('https://github.com/organizations/acme/settings/apps/new')
    expect(form.manifest).toMatchObject({
      name: 'reviewer-acme',
      redirect_url: 'https://api.example.test/v1/github/apps/manifest/callback',
      public: false,
      hook_attributes: { url: 'https://relay.example.test/webhooks/github', active: true }
    })
    expect(form.manifest.default_events).toContain('pull_request')
    expect(form.manifest.setup_url).toMatch(
      /^https:\/\/api\.example\.test\/v1\/github\/apps\/[0-9a-f-]{36}\/setup\/callback\/agent-1$/
    )
  })

  it('makes the App public when the agent works across accounts, and refuses an agent on no repository', async () => {
    const across = harness({
      scope: {
        repositories: [{ fullName: 'acme/tools', kind: 'workspace' }],
        accounts: [{ login: 'other', kind: 'review' }]
      }
    })
    expect((await across.svc.startManifest(ORG, AGENT)).manifest.public).toBe(true)
    const none = harness({ scope: { repositories: [], accounts: [] } })
    await expect(none.svc.startManifest(ORG, AGENT)).rejects.toBeInstanceOf(GithubAppRegistrationError)
  })

  it('converts the code once into a free App of the org and seals its key', async () => {
    const h = harness()
    const state = new URL((await h.svc.startManifest(ORG, AGENT)).action).searchParams.get('state')!
    const done = await h.svc.completeManifest(state, 'code-1')
    expect(done).toMatchObject({
      agentId: 'agent-1',
      installUrl: 'https://github.com/apps/example-review/installations/new'
    })
    expect(h.rows[0]).toMatchObject({ agentId: null, appId: 2000n, slug: 'example-review' })
    expect(h.secrets.get(h.rows[0]!.id)).toBe(REVIEW_KEY_B64)
    expect(h.appsChanged).toHaveBeenCalledWith(ORG)
    await expect(h.svc.completeManifest(state, 'code-1')).resolves.toBeNull()
  })

  it('reports coverage per repository and account, asking GitHub only for selected installations', async () => {
    const orgApp = 'app-review'
    const h = harness({
      scope: {
        repositories: [
          { fullName: 'acme/tools', kind: 'workspace' },
          { fullName: 'acme/infra', kind: 'repository' },
          { fullName: 'beta/web', kind: 'review' }
        ],
        accounts: [{ login: 'acme', kind: 'installation' }]
      },
      installations: [installation({ accountLogin: 'acme', githubAppId: orgApp, repositorySelection: 'selected' })],
      covered: (_owner, repo) => repo === 'tools'
    })
    await expect(h.svc.coverage(AGENT, orgApp)).resolves.toEqual([
      { target: 'acme/tools', kind: 'workspace', covered: true },
      { target: 'acme/infra', kind: 'repository', covered: false },
      { target: 'beta/web', kind: 'review', covered: false },
      { target: 'acme', kind: 'installation', covered: true }
    ])
  })

  it('switches only to a free App that covers everything, and re-compiles the org', async () => {
    const h = harness({
      installations: [installation({ accountLogin: 'acme', githubAppId: 'app-1' })]
    })
    h.rows.push(app({ id: 'app-1', agentId: null }), app({ id: 'app-2', appId: 2001n, agentId: 'agent-9' }))
    await expect(h.svc.switch(AGENT, 'app-2')).resolves.toEqual({ ok: false, reason: 'app_in_use' })
    await expect(h.svc.switch(AGENT, 'app-gone')).resolves.toEqual({ ok: false, reason: 'unknown_app' })
    await expect(h.svc.switch(AGENT, 'app-1')).resolves.toEqual({ ok: true })
    expect(h.switches).toEqual([{ from: null, to: 'app-1' }])
    expect(h.appsChanged).toHaveBeenCalledWith(ORG)

    const uncovered = harness({ installations: [] })
    uncovered.rows.push(app({ id: 'app-1', agentId: null }))
    await expect(uncovered.svc.switch(AGENT, 'app-1')).resolves.toEqual({
      ok: false,
      reason: 'not_covered',
      coverage: [{ target: 'acme/tools', kind: 'workspace', covered: false }]
    })
    expect(uncovered.switches).toEqual([])
  })

  it("re-compiles the org after re-pulling an App's installations, so a reinstall reaches the relay", async () => {
    const h = harness()
    h.rows.push(app({ id: 'own', agentId: 'agent-1' }))
    h.secrets.set('own', REVIEW_KEY_B64)
    await h.svc.sync(ORG, 'own')
    expect(h.appsChanged).toHaveBeenCalledWith(ORG)
  })

  it('deletes only a free App', async () => {
    const h = harness()
    h.rows.push(app({ id: 'free', agentId: null }), app({ id: 'busy', appId: 2001n, agentId: 'agent-1' }))
    await expect(h.svc.delete(ORG, 'busy')).resolves.toBe(false)
    await expect(h.svc.delete(ORG, 'free')).resolves.toBe(true)
    expect(h.invalidate).toHaveBeenCalledWith('free')
    expect(h.rows.map((r) => r.id)).toEqual(['busy'])
  })
})
