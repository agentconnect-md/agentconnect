/**
 * Connectors routes (docs: connectors integration) — the CP-brokered open-connector
 * surface. A real ConnectorsClient is wired over a STUB fetch (no network) so we can
 * assert the composed profile name, the open_connector provider row, org-unique 409,
 * and api-key rollback. Absent connectors ⇒ the routes 404.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { ConnectorsClient, composeProfileName } from '../../src/connectors/index.js'
import type { FetchLike } from '../../src/github/api.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

interface StubCall {
  url: string
  method: string
  body: unknown
}

/** A stub open-connector server: canned catalog, records connection PUT / oauth POST,
 *  and can be told to fail the connection save (to exercise rollback). */
function stubConnectors(opts: { failSave?: boolean } = {}) {
  const calls: StubCall[] = []
  const doFetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith('/api/providers')) {
      return json([
        {
          service: 'github',
          displayName: 'GitHub',
          categories: ['dev'],
          authTypes: ['oauth2'],
          auth: [{ type: 'oauth2' }]
        },
        {
          service: 'slack',
          displayName: 'Slack',
          categories: ['chat'],
          authTypes: ['oauth2'],
          auth: [{ type: 'oauth2' }]
        },
        {
          service: 'stripe',
          displayName: 'Stripe',
          categories: ['pay'],
          authTypes: ['api_key'],
          auth: [{ type: 'api_key' }]
        }
      ])
    }
    if (url.endsWith('/api/oauth/configs')) {
      return json([{ service: 'github', configured: true, clientId: 'gh' }])
    }
    if (url.includes('/api/connections/')) {
      return opts.failSave ? json({ message: 'save failed' }, 500) : json({ ok: true })
    }
    if (url.endsWith('/api/oauth/authorizations')) {
      return json({ authorizationUrl: 'https://provider.example/oauth' })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
  const client = new ConnectorsClient({
    baseUrl: 'http://oc.example.com',
    fetch: doFetch,
    whitelist: null,
    blocklist: new Set(['github', 'slack'])
  })
  return { client, calls }
}

function appWith(connectors?: ConnectorsClient): HttpApp {
  const app = buildHttpApp(prisma, undefined, undefined, undefined, connectors ? { connectors } : undefined)
  opened.push(app)
  return app
}

describe('connectors routes', () => {
  it('reports disabled + 404s the catalog when OPEN_CONNECTOR_URL is unset', async () => {
    const app = appWith()
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/connectors/config` })).json()).toEqual({
      enabled: false
    })
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/connectors/catalog` })).statusCode).toBe(404)
  })

  it('serves the filtered catalog when configured', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/connectors/config` })).json()).toEqual({ enabled: true })
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/connectors/catalog` })
    expect(res.statusCode).toBe(200)
    // Native GitHub/Slack integrations are blocklisted; only the non-conflicting provider remains.
    expect(res.json().providers.map((p: { service: string }) => p.service)).toEqual(['stripe'])
  })

  it('creates an open_connector provider + saves the profile for an api-key connection', async () => {
    const { client, calls } = stubConnectors()
    const app = appWith(client)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'stripe', connectionName: 'prod', authType: 'api_key', values: { apiKey: 'sk_x' } }
    })
    expect(res.statusCode).toBe(201)
    const dto = res.json()
    expect(dto.kind).toBe('open_connector')
    expect(dto.name).toBe('prod')
    expect(dto.service).toBe('stripe')
    expect(typeof dto.grantKey).toBe('string')

    // The provider row is listed as open_connector, with its service slug surfaced
    // (the non-secret binding marker the console uses to resolve the provider icon).
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers` })
    const row = list.json().find((p: { name: string }) => p.name === 'prod')
    expect(row?.kind).toBe('open_connector')
    expect(row?.service).toBe('stripe')

    // The upstream save used the composed profile name.
    const save = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/connections/stripe'))
    expect((save?.body as { connectionName: string }).connectionName).toBe(
      composeProfileName(DEFAULT_ORG_ID, DEFAULT_OWNER_ID, 'prod')
    )
  })

  it('records the provider with restricted visibility when requested', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: {
        service: 'stripe',
        connectionName: 'restricted-conn',
        authType: 'api_key',
        values: { apiKey: 'sk_x' },
        visibility: 'restricted',
        sharedWith: []
      }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().visibility).toBe('restricted')

    const list = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers` })
    expect(list.json().find((p: { name: string }) => p.name === 'restricted-conn')?.visibility).toBe('restricted')
  })

  it('409s a duplicate connection name (org-unique)', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const body = { service: 'stripe', connectionName: 'dup', authType: 'api_key', values: { apiKey: 'x' } }
    expect(
      (await app.app.inject({ method: 'POST', url: `${ORG}/connectors/connections`, payload: body })).statusCode
    ).toBe(201)
    expect(
      (await app.app.inject({ method: 'POST', url: `${ORG}/connectors/connections`, payload: body })).statusCode
    ).toBe(409)
  })

  it('rolls back the provider row when the upstream api-key save fails', async () => {
    const { client } = stubConnectors({ failSave: true })
    const app = appWith(client)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'stripe', connectionName: 'willfail', authType: 'api_key', values: { apiKey: 'x' } }
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const list = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers` })
    expect(list.json().find((p: { name: string }) => p.name === 'willfail')).toBeUndefined()
  })

  it('returns an authorizationUrl for an oauth2 connection', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'github', connectionName: 'gh', authType: 'oauth2' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().authorizationUrl).toBe('https://provider.example/oauth')
  })

  it('reconnects an oauth2 connection — re-runs authorization for the same profile', async () => {
    const { client, calls } = stubConnectors()
    const app = appWith(client)
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'github', connectionName: 'gh', authType: 'oauth2' }
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections/${id}/reconnect`,
      payload: { authType: 'oauth2' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().authorizationUrl).toBe('https://provider.example/oauth')

    // The reconnect authorization used the SAME composed profile as create (no new row).
    const authCalls = calls.filter((c) => c.url.endsWith('/api/oauth/authorizations'))
    expect(authCalls).toHaveLength(2) // create + reconnect
    expect((authCalls[1]?.body as { connectionName: string }).connectionName).toBe(
      composeProfileName(DEFAULT_ORG_ID, DEFAULT_OWNER_ID, 'gh')
    )
  })

  it('reconnects an api-key connection — re-saves credentials under the same profile', async () => {
    const { client, calls } = stubConnectors()
    const app = appWith(client)
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'stripe', connectionName: 'prod', authType: 'api_key', values: { apiKey: 'sk_x' } }
    })
    const id = created.json().id

    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections/${id}/reconnect`,
      payload: { authType: 'api_key', values: { apiKey: 'sk_rotated' } }
    })
    expect(res.statusCode).toBe(200)
    const saves = calls.filter((c) => c.method === 'PUT' && c.url.includes('/api/connections/stripe'))
    expect(saves).toHaveLength(2) // create + reconnect
    const reconnectSave = saves[1]?.body as { connectionName: string; values: { apiKey: string } }
    expect(reconnectSave.connectionName).toBe(composeProfileName(DEFAULT_ORG_ID, DEFAULT_OWNER_ID, 'prod'))
    expect(reconnectSave.values.apiKey).toBe('sk_rotated')
  })

  it('404s reconnect of an unknown id', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const res = await app.app.inject({
      method: 'POST',
      // Well-formed but nonexistent uuid → clean 404 (a non-uuid would throw at the Uuid column).
      url: `${ORG}/connectors/connections/${randomUUID()}/reconnect`,
      payload: { authType: 'oauth2' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('400s reconnect of a custom (non-open_connector) provider', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const custom = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'plain', url: 'https://mcp.example.com/sse', headers: [] }
    })
    expect(custom.statusCode).toBe(201)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections/${custom.json().id}/reconnect`,
      payload: { authType: 'oauth2' }
    })
    expect(res.statusCode).toBe(400)
  })

  it('404s reconnect when OPEN_CONNECTOR_URL is unset', async () => {
    const app = appWith()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections/any-id/reconnect`,
      payload: { authType: 'oauth2' }
    })
    expect(res.statusCode).toBe(404)
  })

  // The url + x-oomol-connector-* headers of an open_connector row are CP-managed; PATCHing
  // them would sever the binding, so the mcp-providers edit surface refuses connector rows.
  it('400s a PATCH of an open_connector provider’s url/headers', async () => {
    const { client } = stubConnectors()
    const app = appWith(client)
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/connectors/connections`,
      payload: { service: 'stripe', connectionName: 'locked', authType: 'api_key', values: { apiKey: 'x' } }
    })
    const id = created.json().id
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/mcp-providers/${id}`,
      payload: { url: 'https://attacker.example/mcp' }
    })
    expect(res.statusCode).toBe(400)
  })

  // A custom provider must NOT be able to carry the x-oomol-connector-* markers, or it
  // could impersonate an open_connector binding at the relay (SSRF/cross-tenant path).
  it('rejects reserved x-oomol-connector-* headers on a custom mcp-provider', async () => {
    const app = appWith()
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: {
        name: 'evil',
        url: 'https://attacker.example/mcp',
        headers: [{ name: 'x-oomol-connector-alias', value: 'other-org--other-user--x' }]
      }
    })
    expect(res.statusCode).toBe(400)
  })
})
