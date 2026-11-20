// @vitest-environment happy-dom
/** The Setup page's Email section against the real routes: a returned ingress secret stays until the operator dismisses it, and Replace asks in the page. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { HTMLElement, HTMLInputElement, Window } from 'happy-dom'
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
const TOKEN = 'example-api-token'
const OLD_SECRET = 's'.repeat(43)

let running: FastifyInstance | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await running?.close()
  running = undefined
})

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})

function server(values: DeploymentConfigValuesV1, initial: Record<string, string>) {
  const sealed = new Map(Object.entries(initial))
  const rows = () =>
    [...sealed.keys()].map((key) => ({
      key,
      configured: true,
      fingerprint: 'sha256:fingerprint',
      updatedAt: new Date(0)
    }))
  const admin = {
    schemaVersion: 1 as const,
    revision: 4,
    values,
    secrets: rows(),
    adminClaimedFor: null,
    updatedAt: new Date(0)
  }
  const store = {
    getAdmin: async () => admin,
    replace: async (input: { values: DeploymentConfigValuesV1; secrets?: Record<string, string | null> }) => {
      admin.values = input.values
      admin.revision += 1
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) sealed.delete(key)
        else sealed.set(key, value)
      }
      admin.secrets = rows()
      return admin
    },
    getRuntime: async () => ({ values: admin.values, secrets: Object.fromEntries(sealed) }),
    markAdminClaimed: async () => {}
  } as unknown as DeploymentConfigStore
  const cloudflare = (async (input: string | URL | Request) =>
    String(input) === emailTokenProbeUrl(ACCOUNT)
      ? Response.json({ success: true, errors: [], result: [] })
      : Response.json({ success: false }, { status: 403 })) as typeof fetch
  const app = buildSetupServer({
    store,
    publicUrl: 'http://localhost:8091',
    fetch: cloudflare,
    localAuthBootstrap: {
      issuer: 'https://login.example.test/oidc',
      services: {
        web: 'https://console.example.test',
        controlPlane: 'https://api.example.test',
        relay: 'https://relay.example.test'
      }
    }
  })
  running = app
  return { app, sealed }
}

/** Boots the page with its requests answered by the real routes, as a signed-in administrator. */
async function openPage(app: FastifyInstance) {
  const posts: unknown[] = []
  const statusReads = { count: 0 }
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input)
    // The page signs in through OIDC; the routes underneath run without authentication.
    if (url === '/api/v1/auth-config') return Response.json({ mode: 'oidc', claimAvailable: false })
    if (url === '/api/v1/check/logto') return Response.json({ findings: [] })
    if (url === '/api/v1/deployment-config' && !init.method) statusReads.count += 1
    if (url === '/api/v1/configure/email') posts.push(JSON.parse(String(init.body)))
    const reply = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url,
      ...(init.body ? { payload: String(init.body), headers: { 'content-type': 'application/json' } } : {})
    })
    return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('confirm', () => false)
  sessionStorage.setItem('agentconnect.setup.token', 'example-id-token')
  const body = /<body>([\s\S]*)<script>/.exec(SETUP_HTML)![1]!
  const script = /<script>([\s\S]*?)<\/script>/.exec(SETUP_HTML)![1]!
  page.document.body.innerHTML = body
  new Function(script)()
  await vi.waitFor(() => expect(byId('setup').hidden).toBe(false))
  // Lets the Logto check that every load starts render the page once more.
  await vi.waitFor(() => expect(statusReads.count).toBeGreaterThanOrEqual(2))
  return { posts, statusReads }
}

const page = globalThis as unknown as Window
const byId = (id: string) => page.document.getElementById(id) as HTMLElement
const input = (id: string, value: string) => {
  ;(byId(id) as HTMLInputElement).value = value
}
const secretBox = () => ({
  shown: !byId('email-ingress-once').hidden,
  secret: byId('email-ingress-secret').textContent
})

/** Renders the status again the way the page's own Logto check does, and waits until it has. */
async function renderStatusAgain(statusReads: { count: number }) {
  const before = statusReads.count
  byId('check-logto').click()
  await vi.waitFor(() => expect(statusReads.count).toBe(before + 1))
  await vi.waitFor(() => expect(byId('logto-status').textContent).toMatch(/match/))
}

describe('Setup page: Email ingress secret', () => {
  it('keeps the secret a save returned across status renders until Dismiss, and nowhere but the page', async () => {
    const { app, sealed } = server(DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, {})
    const { statusReads } = await openPage(app)

    input('email-mail-domain-input', DOMAIN)
    input('email-account-id-input', ACCOUNT)
    input('email-token', TOKEN)
    byId('save-email').click()
    await vi.waitFor(() => expect(secretBox().shown).toBe(true))
    const generated = sealed.get('email.ingressSecret')
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(secretBox().secret).toBe(generated)
    await vi.waitFor(() => expect(byId('email-match').textContent).toBe('Checked on save'))

    await renderStatusAgain(statusReads)
    await renderStatusAgain(statusReads)
    expect(secretBox()).toEqual({ shown: true, secret: generated })
    const stored = [sessionStorage, localStorage].flatMap((storage) =>
      Object.keys(storage).map((key) => storage.getItem(key))
    )
    expect(stored.join('\n')).not.toContain(generated)
    expect(page.location.href).not.toContain(generated)

    const copied = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copied } })
    byId('copy-email-ingress').click()
    await vi.waitFor(() => expect(copied).toHaveBeenCalledWith(generated))
    expect(secretBox().shown).toBe(true)

    byId('dismiss-email-ingress').click()
    expect(secretBox()).toEqual({ shown: false, secret: '' })
    await renderStatusAgain(statusReads)
    expect(secretBox().shown).toBe(false)
  })

  it('asks before Replace in the page, posts only once confirmed, and shows the new secret', async () => {
    const { app, sealed } = server(
      { ...DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, email: { mailDomain: DOMAIN, accountId: ACCOUNT } },
      { 'email.apiToken': TOKEN, 'email.ingressSecret': OLD_SECRET }
    )
    const nativeConfirm = vi.fn(() => false)
    const { posts, statusReads } = await openPage(app)
    vi.stubGlobal('confirm', nativeConfirm)
    const asking = () => !byId('email-rotate-confirm').hidden

    byId('rotate-email-ingress').click()
    expect(asking()).toBe(true)
    expect(byId('rotate-email-ingress').hidden).toBe(true)
    expect(byId('email-rotate-confirm').textContent).toContain('Mail is refused until the Worker has the new one.')
    // A status render meanwhile leaves the question open.
    await renderStatusAgain(statusReads)
    expect(asking()).toBe(true)
    expect(byId('rotate-email-ingress').hidden).toBe(true)

    byId('cancel-rotate-email-ingress').click()
    expect(asking()).toBe(false)
    expect(byId('rotate-email-ingress').hidden).toBe(false)
    expect(posts).toEqual([])

    byId('rotate-email-ingress').click()
    byId('confirm-rotate-email-ingress').click()
    await vi.waitFor(() => expect(secretBox().shown).toBe(true))
    expect(posts).toEqual([
      { email: { mailDomain: DOMAIN, accountId: ACCOUNT, dailySendLimit: null, rotateIngressSecret: true } }
    ])
    const rotated = sealed.get('email.ingressSecret')
    expect(rotated).not.toBe(OLD_SECRET)
    expect(secretBox().secret).toBe(rotated)
    expect(nativeConfirm).not.toHaveBeenCalled()
    await renderStatusAgain(statusReads)
    expect(secretBox()).toEqual({ shown: true, secret: rotated })
  })

  it('takes the secret off the page when the configuration is cleared', async () => {
    const { app } = server(DEFAULT_DEPLOYMENT_CONFIG_VALUES_V1, {})
    await openPage(app)
    input('email-mail-domain-input', DOMAIN)
    input('email-account-id-input', ACCOUNT)
    input('email-token', TOKEN)
    byId('save-email').click()
    await vi.waitFor(() => expect(secretBox().shown).toBe(true))
    await vi.waitFor(() => expect(byId('clear-email').hidden).toBe(false))

    vi.stubGlobal('confirm', () => true)
    byId('clear-email').click()
    await vi.waitFor(() => expect(secretBox()).toEqual({ shown: false, secret: '' }))
    expect(byId('email-match').textContent).toBe('Not configured')
  })
})
