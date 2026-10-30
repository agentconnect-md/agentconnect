/**
 * Unit tests for organization-registered GitHub Apps (no Docker, no network):
 * the registry's per-installation signer, registration against a fake GitHub,
 * and the token service signing with the installation's own App.
 */
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
  function harness(opts: { ghApp?: { id: number; slug: string; client_id?: string }; installations?: unknown[] } = {}) {
    const rows: GithubAppRecord[] = []
    const claimed: Array<{ orgId: string; installationId: bigint; githubAppId?: string | null }> = []
    const revoked: bigint[] = []
    const secrets = new Map<string, string>()
    const invalidate = vi.fn()
    const changed: bigint[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/app'))
        return Response.json(opts.ghApp ?? { id: 2000, slug: 'example-review', client_id: 'Iv1' })
      if (url.includes('/app/installations')) {
        return Response.json(
          opts.installations ?? [
            {
              id: 43,
              account: { login: 'acme', type: 'Organization' },
              repository_selection: 'all',
              suspended_at: null
            }
          ]
        )
      }
      throw new Error(`unexpected github call: ${url}`)
    }
    const svc = new GithubAppsService({
      apps: {
        create: async (input) => {
          const row = app({ ...input, id: `app-${rows.length + 1}` })
          rows.push(row)
          return row
        },
        get: async (_org, id) => rows.find((r) => r.id === id) ?? null,
        getUnscoped: async (id) => rows.find((r) => r.id === id) ?? null,
        listForOrg: async () => rows,
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
          return installation({
            orgId,
            installationId: facts.installationId,
            githubAppId,
            accountLogin: facts.accountLogin
          })
        },
        listClaimsForOrg: async () => [
          ...claimed.map((c) => installation({ installationId: c.installationId, githubAppId: c.githubAppId })),
          // claimed earlier, gone on GitHub
          installation({
            installationId: 99n,
            githubAppId: 'app-1',
            revokedAt: revoked.includes(99n) ? new Date(1) : null
          })
        ],
        markRevokedByInstallationId: async (id) => void revoked.push(id)
      },
      registry: { invalidate },
      deploymentAppId: 1000,
      botUserId: async (slug) => (slug === 'example-review' ? 77 : -1),
      onInstallationChanged: async (id) => void changed.push(id),
      fetchImpl
    })
    return { svc, rows, claimed, revoked, secrets, invalidate, changed }
  }

  it('verifies the key names the given App, records the bot user, seals the key and claims the installations', async () => {
    const { svc, claimed, revoked, secrets, invalidate, changed } = harness()
    const { app: row, installations } = await svc.register(ORG, { appId: 2000, privateKeyB64: REVIEW_KEY_B64 })
    expect(row).toMatchObject({ appId: 2000n, slug: 'example-review', clientId: 'Iv1', botUserId: 77n })
    expect(secrets.get(row.id)).toBe(REVIEW_KEY_B64)
    expect(invalidate).toHaveBeenCalledWith(row.id)
    expect(claimed).toEqual([{ orgId: ORG, installationId: 43n, githubAppId: row.id }])
    expect(installations.map((i) => i.installationId)).toEqual([43n])
    expect(revoked).toEqual([99n])
    expect(changed).toEqual([43n, 99n])
  })

  it('refuses the deployment App, a key for another App, and an unparsable key', async () => {
    const { svc, rows } = harness()
    await expect(svc.register(ORG, { appId: 1000, privateKeyB64: REVIEW_KEY_B64 })).rejects.toBeInstanceOf(
      GithubAppRegistrationError
    )
    await expect(svc.register(ORG, { appId: 2001, privateKeyB64: REVIEW_KEY_B64 })).rejects.toThrow(
      /belongs to GitHub App 2000/
    )
    await expect(
      svc.register(ORG, { appId: 2000, privateKeyB64: Buffer.from('not a pem').toString('base64') })
    ).rejects.toBeInstanceOf(GithubAppRegistrationError)
    expect(rows).toEqual([])
  })

  it('delete forgets the App, drops its signer and invalidates its installations', async () => {
    const { svc, rows, invalidate, changed } = harness()
    const { app: row } = await svc.register(ORG, { appId: 2000, privateKeyB64: REVIEW_KEY_B64 })
    changed.length = 0
    await expect(svc.delete(ORG, row.id)).resolves.toBe(true)
    expect(rows).toEqual([])
    expect(invalidate).toHaveBeenLastCalledWith(row.id)
    expect(changed).toEqual([43n])
    await expect(svc.delete(ORG, row.id)).resolves.toBe(false)
  })
})
