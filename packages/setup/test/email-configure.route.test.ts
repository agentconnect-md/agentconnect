/** Setup → Email (email-integration.md §7): the mail domain and account are document state, the token is checked and write-only, and the ingress secret is generated here and shown once. */
import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  type DeploymentConfigStore,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { buildSetupServer } from '../src/server/index.js'
import { SETUP_HTML } from '../src/server/html.js'
import { emailTokenProbeUrl } from '../src/email-probe.js'

const DOMAIN = 'mail.example.test'
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OTHER_ACCOUNT = 'f'.repeat(32)
const TOKEN = 'example-api-token'
const STORED_TOKEN = 'example-stored-token'
const SERVICES = {
  web: 'https://console.example.test',
  controlPlane: 'https://api.example.test',
  relay: 'https://relay.example.test'
}

let running: FastifyInstance | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

interface Replaced {
  values: DeploymentConfigValuesV1
  secrets?: Record<string, string | null>
}

function server(
  opts: {
    values?: DeploymentConfigValuesV1
    secrets?: Record<string, string>
    /** The tokens Cloudflare accepts for ACCOUNT; any other is refused. */
    accepted?: string[]
    unreachable?: boolean
    relay?: string
  } = {}
) {
  const writes: Replaced[] = []
  const probes: string[] = []
  const sealed = new Map(Object.entries(opts.secrets ?? {}))
  const admin = {
    schemaVersion: 1 as const,
    revision: 4,
    values: opts.values ?? DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
    // Redacted status rows, exactly as the store projects them: never a value.
    secrets: [...sealed.keys()].map((key) => ({
      key,
      configured: true,
      fingerprint: 'sha256:fingerprint' as string | null,
      updatedAt: new Date('2026-09-01T00:00:00.000Z') as Date | null
    })),
    adminClaimedFor: null,
    updatedAt: new Date('2026-09-01T00:00:00.000Z')
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: Replaced & { expectedRevision: number }) => {
      writes.push({ values: input.values, ...(input.secrets ? { secrets: input.secrets } : {}) })
      admin.values = input.values
      admin.revision += 1
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        admin.secrets = admin.secrets.filter((secret) => secret.key !== key)
        if (value === null) sealed.delete(key)
        else {
          sealed.set(key, value)
          admin.secrets.push({ key, configured: true, fingerprint: 'sha256:fingerprint', updatedAt: admin.updatedAt })
        }
      }
      return admin
    },
    getRuntime: async () => ({ values: admin.values, secrets: Object.fromEntries(sealed) }),
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const accepted = new Set(opts.accepted ?? [TOKEN, STORED_TOKEN])
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (opts.unreachable) throw new TypeError('fetch failed')
    const url = String(input)
    if (url !== emailTokenProbeUrl(ACCOUNT)) return Response.json({ success: false }, { status: 403 })
    const token = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, '')
    probes.push(token)
    return accepted.has(token)
      ? Response.json({ success: true, errors: [], result: [] })
      : Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 })
  }) as typeof fetch
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    fetch: fetchImpl,
    localAuthBootstrap: {
      issuer: 'https://login.example.test/oidc',
      services: { ...SERVICES, ...(opts.relay ? { relay: opts.relay } : {}) }
    }
  })
  running = app
  return { app, writes, probes }
}

const configure = (app: FastifyInstance, email: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/configure/email', payload: { email } })

const configured: DeploymentConfigValuesV1 = {
  ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1,
  email: { mailDomain: DOMAIN, accountId: ACCOUNT }
}
const stored = { 'email.apiToken': STORED_TOKEN, 'email.ingressSecret': 's'.repeat(43) }

describe('POST /api/v1/configure/email (§7)', () => {
  it('checks the token, saves the domain and account, and shows a generated ingress secret once', async () => {
    const { app, writes, probes } = server()

    const response = await configure(app, {
      mailDomain: ' Mail.Example.Test ',
      accountId: ACCOUNT.toUpperCase(),
      apiToken: TOKEN,
      dailySendLimit: 500
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ingressSecret: string; inboundUrl: string; probe: { status: string } }
    expect(body).toMatchObject({
      revision: 5,
      restartRequired: true,
      inboundUrl: 'https://relay.example.test/email/inbound',
      probe: { status: 'ok' }
    })
    expect(probes).toEqual([TOKEN])
    expect(writes[0]?.values.email).toEqual({ mailDomain: DOMAIN, accountId: ACCOUNT, dailySendLimit: 500 })
    // 32 random bytes, which the relay's snapshot requires at least 32 characters of.
    expect(body.ingressSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(writes[0]?.secrets).toEqual({ 'email.apiToken': TOKEN, 'email.ingressSecret': body.ingressSecret })
    expect(response.body).not.toContain(TOKEN)

    // Neither secret is ever read back.
    const status = await app.inject({ method: 'GET', url: '/api/v1/deployment-config' })
    expect(status.body).not.toContain(TOKEN)
    expect(status.body).not.toContain(body.ingressSecret)
    expect(status.json().providerExpectations.email).toMatchObject({
      inboundUrl: 'https://relay.example.test/email/inbound'
    })
  })

  it('refuses a token Cloudflare refuses, and saves nothing when it cannot ask', async () => {
    const refused = server({ accepted: [] })
    const bad = await configure(refused.app, { mailDomain: DOMAIN, accountId: ACCOUNT, apiToken: TOKEN })
    expect(bad.statusCode).toBe(400)
    expect(bad.body).not.toContain(TOKEN)
    expect(refused.writes).toEqual([])

    const offline = server({ unreachable: true })
    const unreachable = await configure(offline.app, { mailDomain: DOMAIN, accountId: ACCOUNT, apiToken: TOKEN })
    expect(unreachable.statusCode).toBe(502)
    expect(offline.writes).toEqual([])
  })

  it('keeps the stored token and ingress secret on an edit of the same account, re-checking the token', async () => {
    const { app, writes, probes } = server({ values: configured, secrets: stored })

    const response = await configure(app, {
      mailDomain: 'agents.example.test',
      accountId: ACCOUNT,
      dailySendLimit: null
    })
    expect(response.statusCode).toBe(200)
    expect(probes).toEqual([STORED_TOKEN])
    expect(response.json()).not.toHaveProperty('ingressSecret')
    expect(writes[0]?.values.email).toEqual({ mailDomain: 'agents.example.test', accountId: ACCOUNT })
    expect(writes[0]?.secrets).toBeUndefined()
    expect(response.body).not.toContain(STORED_TOKEN)
  })

  it('needs a token for a new account, and before the first save', async () => {
    const fresh = server()
    expect((await configure(fresh.app, { mailDomain: DOMAIN, accountId: ACCOUNT })).statusCode).toBe(400)
    expect(fresh.probes).toEqual([])

    const moved = server({ values: configured, secrets: stored })
    const response = await configure(moved.app, { mailDomain: DOMAIN, accountId: OTHER_ACCOUNT })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/paste the API token/)
    expect(moved.probes).toEqual([])
    expect(moved.writes).toEqual([])
  })

  it('replaces the ingress secret only when asked, and shows the new one once', async () => {
    const { app, writes } = server({ values: configured, secrets: stored })

    const response = await configure(app, { mailDomain: DOMAIN, accountId: ACCOUNT, rotateIngressSecret: true })
    expect(response.statusCode).toBe(200)
    const rotated = (response.json() as { ingressSecret: string }).ingressSecret
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(rotated).not.toBe(stored['email.ingressSecret'])
    expect(writes[0]?.secrets).toEqual({ 'email.ingressSecret': rotated })
  })

  it('refuses a malformed domain, account or limit and writes nothing', async () => {
    const { app, writes } = server()

    for (const email of [
      { mailDomain: 'not a domain', accountId: ACCOUNT, apiToken: TOKEN },
      { mailDomain: DOMAIN, accountId: 'example-account', apiToken: TOKEN },
      { mailDomain: DOMAIN, accountId: ACCOUNT, apiToken: TOKEN, dailySendLimit: 0 },
      { mailDomain: DOMAIN, accountId: ACCOUNT, apiToken: TOKEN, sender: 'unknown-field' }
    ]) {
      const response = await configure(app, email)
      expect(response.statusCode, JSON.stringify(email)).toBe(400)
      expect(response.body).not.toContain(TOKEN)
    }
    expect(writes).toEqual([])
  })

  it('needs an HTTPS ingress URL, which the Worker posts to', async () => {
    const { app, writes, probes } = server({ relay: 'http://localhost:8090' })

    const response = await configure(app, { mailDomain: DOMAIN, accountId: ACCOUNT, apiToken: TOKEN })
    expect(response.statusCode).toBe(409)
    expect(probes).toEqual([])
    expect(writes).toEqual([])
  })

  it('clears the domain and both secrets together', async () => {
    const { app, writes } = server({ values: configured, secrets: stored })

    const response = await configure(app, null)
    expect(response.statusCode).toBe(200)
    expect(writes[0]?.values.email).toBeNull()
    expect(writes[0]?.secrets).toEqual({ 'email.apiToken': null, 'email.ingressSecret': null })
  })

  it('ships a page whose script parses and offers the Email controls', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(SETUP_HTML)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Script(`(async () => {${script}\n})`)).not.toThrow()
    for (const id of ['email-section', 'save-email', 'rotate-email-ingress', 'clear-email', 'email-ingress-secret'])
      expect(SETUP_HTML).toContain(`id="${id}"`)
  })
})
