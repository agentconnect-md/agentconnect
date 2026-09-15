/**
 * The MCP-provider authorization funnel over real HTTP and a real database.
 *
 * The unit suite already covers the service's decisions; what only an end-to-end run can
 * catch is the wiring around them. Two things in particular:
 *
 *  - the begin/callback hops must route under BOTH the internal `/api/v1` prefix and the
 *    public `/v1` alias. The redirect_uri is registered with a third-party authorization
 *    server ONCE, in its public form, so mounting one prefix is a failure that appears in
 *    production and nowhere else; and
 *  - a completed funnel must put the access token into the relay binding and must NOT put
 *    it, or anything else sealed, into a DTO.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgMcpProviderOauthRepo, PgMcpProviderOauthSecretStore } from '../../src/persistence/index.js'
import { PgMcpProviderOauthStateStore, PgMcpProviderRepo } from '../../src/persistence/index.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { McpProviderOauthService } from '../../src/mcp-oauth/service.js'
import { McpProviderTokenService } from '../../src/mcp-oauth/token-service.js'
import type { Dial } from '../../src/mcp-oauth/discovery.js'
import type { GuardedResult } from '../../src/net/guarded-fetch.js'
import { OrgId } from '../../src/domain/ids.js'
import { serializeByProvider } from '../../src/http/provider-chain.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PUBLIC_CP = 'https://api.example.test'
const MCP_URL = 'https://mcp.example.test/mcp'
const PRM_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
const ISSUER = 'https://auth.example.test'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

const ok = (status: number, json: unknown, headers: Record<string, string | string[]> = {}): GuardedResult => ({
  ok: true,
  response: { status, headers, text: JSON.stringify(json ?? null), json }
})

/** A complete, well-behaved authorization server: challenge, metadata, DCR, token. */
function fakeUpstream(over: Record<string, GuardedResult> = {}): Dial {
  const table: Record<string, GuardedResult> = {
    [MCP_URL]: ok(401, undefined, { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}", scope="files:read"` }),
    [PRM_URL]: ok(200, { resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ['files:read'] }),
    [`${ISSUER}/.well-known/oauth-authorization-server`]: ok(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      authorization_response_iss_parameter_supported: true
    }),
    [`${ISSUER}/register`]: ok(201, { client_id: 'dcr-id' }),
    [`${ISSUER}/token`]: ok(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    ...over
  }
  return async (url) => table[url] ?? { ok: false, failure: 'unreachable' }
}

/** Captures what the CP actually broadcasts to the relay pool, so a test can assert the
 *  binding a rotation or a PATCH publishes rather than trusting the route's return value. */
function captureRelay(app: HttpApp): Array<{ frame: string; body: Record<string, unknown> }> {
  const seen: Array<{ frame: string; body: Record<string, unknown> }> = []
  app.relayReg.add({
    relayId: 'relay-test',
    send: (frame: string, body: unknown) => {
      seen.push({ frame, body: body as Record<string, unknown> })
    },
    close: () => {}
  } as never)
  return seen
}

function makeApp(dial: Dial): { app: HttpApp; bound: Array<{ providerId: string; headers: unknown }> } {
  const cipher = new PlaintextSecretCipher()
  const bound: Array<{ providerId: string; headers: unknown }> = []
  const oauth = new McpProviderOauthService({
    providers: new PgMcpProviderRepo(prisma),
    oauth: new PgMcpProviderOauthRepo(prisma),
    secrets: new PgMcpProviderOauthSecretStore(prisma, cipher),
    states: new PgMcpProviderOauthStateStore(prisma),
    cipher,
    dial,
    publicCpUrl: PUBLIC_CP,
    webAppUrl: 'https://console.example.test',
    onConnected: async (orgId, providerId) => {
      const sealed = await new PgMcpProviderOauthSecretStore(prisma, cipher).get(orgId, providerId)
      bound.push({ providerId, headers: [{ name: 'Authorization', value: `Bearer ${sealed?.accessToken}` }] })
    }
  })
  // Mirrors the container's own assembly: token custody is what every live publication
  // resolves an oauth2 provider's header through, and disconnect drops only the binding.
  const tokens = new McpProviderTokenService({
    oauth: new PgMcpProviderOauthRepo(prisma),
    secrets: new PgMcpProviderOauthSecretStore(prisma, cipher),
    cipher,
    dial
  })
  const app = buildHttpApp(prisma, { PUBLIC_CP_URL: PUBLIC_CP }, undefined, undefined, {
    mcpProviderOauth: oauth,
    mcpTokenResolver: tokens,
    mcpOauthUnbind: async (_orgId, provider) => {
      app.deps.relayControl.mcpUnassign({ providerId: provider.id })
    }
  })
  opened.push(app)
  return { app, bound }
}

async function createOauthProvider(app: HttpApp): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers`,
    payload: { name: `oauth-${randomUUID().slice(0, 8)}`, url: MCP_URL, auth: 'oauth2', headers: [] }
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

/** start → begin → callback, over whichever prefix the browser hops are addressed at. */
async function walk(app: HttpApp, providerId: string, prefix: '/api/v1' | '/v1') {
  const started = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers/${providerId}/oauth/start`,
    payload: { returnPath: '/tools' }
  })
  expect(started.statusCode).toBe(200)
  const { url } = started.json() as { url: string }
  expect(url.startsWith(`${PUBLIC_CP}/v1/mcp-providers/oauth/begin?state=`)).toBe(true)
  const state = new URL(url).searchParams.get('state')!

  const begun = await app.app.inject({ method: 'GET', url: `${prefix}/mcp-providers/oauth/begin?state=${state}` })
  expect(begun.statusCode).toBe(302)
  const cookie = (begun.headers['set-cookie'] as string).split(';')[0]!
  const authorize = new URL(begun.headers.location as string)

  const done = await app.app.inject({
    method: 'GET',
    url: `${prefix}/mcp-providers/oauth/callback?state=${state}&code=code-1&iss=${encodeURIComponent(ISSUER)}`,
    headers: { cookie }
  })
  return { state, cookie, authorize, done }
}

describe('MCP provider OAuth funnel', () => {
  it.each(['/api/v1', '/v1'] as const)('completes over the %s mount', async (prefix) => {
    const { app, bound } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    const { authorize, done } = await walk(app, providerId, prefix)

    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('resource')).toBe(MCP_URL)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_CP}/v1/mcp-providers/oauth/callback`)
    expect(done.statusCode).toBe(302)
    expect(done.headers.location).toBe('https://console.example.test/tools?mcpOauth=connected')
    // The grant landed AND was projected as the binding's injected credential.
    expect(bound).toEqual([{ providerId, headers: [{ name: 'Authorization', value: 'Bearer access-1' }] }])
  })

  it('shows the connection state without ever returning a token', async () => {
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')

    const res = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { auth: string; oauth?: { status: string; issuer: string } }
    expect(dto.auth).toBe('oauth2')
    expect(dto.oauth).toMatchObject({ status: 'connected', issuer: ISSUER })
    expect(res.body).not.toContain('access-1')
    expect(res.body).not.toContain('refresh-1')
  })

  it('fails a replayed callback closed, with the same result as an unknown state', async () => {
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    const { state, cookie } = await walk(app, providerId, '/api/v1')
    const replay = await app.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-providers/oauth/callback?state=${state}&code=code-1&iss=${encodeURIComponent(ISSUER)}`,
      headers: { cookie }
    })
    expect(replay.statusCode).toBe(302)
    expect(replay.headers.location).toBe('https://console.example.test/?mcpOauth=state_invalid')
  })

  it('refuses a callback carrying an issuer the funnel did not start with', async () => {
    const { app, bound } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/oauth/start`,
      payload: { returnPath: '/tools' }
    })
    const state = new URL((started.json() as { url: string }).url).searchParams.get('state')!
    const begun = await app.app.inject({ method: 'GET', url: `/api/v1/mcp-providers/oauth/begin?state=${state}` })
    const cookie = (begun.headers['set-cookie'] as string).split(';')[0]!
    const done = await app.app.inject({
      method: 'GET',
      url: `/api/v1/mcp-providers/oauth/callback?state=${state}&code=code-1&iss=https%3A%2F%2Fevil.example.test`,
      headers: { cookie }
    })
    expect(done.headers.location).toBe('https://console.example.test/tools?mcpOauth=issuer_mismatch')
    expect(bound).toHaveLength(0)
  })

  it('refuses a grant with no refresh token rather than binding one that dies at first expiry', async () => {
    const { app, bound } = makeApp(
      fakeUpstream({ [`${ISSUER}/token`]: ok(200, { access_token: 'access-1', expires_in: 3600 }) })
    )
    const providerId = await createOauthProvider(app)
    const { done } = await walk(app, providerId, '/api/v1')
    expect(done.headers.location).toBe('https://console.example.test/tools?mcpOauth=no_refresh_token')
    expect(bound).toHaveLength(0)
  })

  it('surfaces a server that does not advertise OAuth as its own refusal', async () => {
    const { app } = makeApp(
      fakeUpstream({
        [MCP_URL]: ok(200, { jsonrpc: '2.0', id: 0, result: {} }),
        [PRM_URL]: ok(404, undefined),
        'https://mcp.example.test/.well-known/oauth-protected-resource': ok(404, undefined)
      })
    )
    const providerId = await createOauthProvider(app)
    const started = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/oauth/start`,
      payload: {}
    })
    expect(started.statusCode).toBe(400)
    expect((started.json() as { message: string }).message).toBe('discovery_not_protected')
  })

  it('refuses an oauth2 provider that also carries static headers', async () => {
    const { app } = makeApp(fakeUpstream())
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: {
        name: `oauth-${randomUUID().slice(0, 8)}`,
        url: MCP_URL,
        auth: 'oauth2',
        headers: [{ name: 'Authorization', value: 'Bearer static' }]
      }
    })
    expect(res.statusCode).toBe(400)
  })

  it('keeps the OAuth credential on the binding across a grant rotation', async () => {
    // The regression: a rotation read the STATIC header set — empty for an oauth2 provider —
    // and republished the binding with no Authorization at all, silently breaking it.
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')
    const relay = captureRelay(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/grant/rotate`,
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    const assign = relay.filter((f) => f.frame === 'rc/mcp-assign').at(-1)
    expect(assign?.body.headers).toEqual([{ name: 'Authorization', value: 'Bearer access-1' }])
  })

  it('keeps the OAuth credential on the binding across a PATCH', async () => {
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')
    const relay = captureRelay(app)
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/mcp-providers/${providerId}`,
      payload: { url: 'https://mcp.example.test/mcp?v=2' }
    })
    expect(res.statusCode).toBe(200)
    const assign = relay.filter((f) => f.frame === 'rc/mcp-assign').at(-1)
    expect(assign?.body.headers).toEqual([{ name: 'Authorization', value: 'Bearer access-1' }])
  })

  it('publishes no binding for a provider that has never been authorized', async () => {
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    const relay = captureRelay(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/grant/rotate`,
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    // A binding with an empty credential is worse than none: it would answer calls that then
    // fail upstream, and it would overwrite a real one later.
    expect(relay.filter((f) => f.frame === 'rc/mcp-assign')).toHaveLength(0)
  })

  it('disconnect drops the relay binding but keeps the daemon definition', async () => {
    // The regression: disconnect sent `mcpserver/remove` to every enabling daemon, while a
    // later reconnect republishes only the binding — so the server stayed missing.
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')
    const relay = captureRelay(app)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/oauth/disconnect`,
      payload: {}
    })
    expect(res.statusCode).toBe(204)
    expect(relay.filter((f) => f.frame === 'rc/mcp-unassign')).toHaveLength(1)
  })

  it('serializes disconnect with the provider chain, so a racing rebind cannot outlive it', async () => {
    // The hazard: a refresher rebind re-reads this provider INSIDE the chain. If disconnect
    // ran outside it, a rebind that had already read a live credential could publish its
    // binding after the unbind, leaving a callable binding for a revoked grant.
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')
    const provider = await new PgMcpProviderRepo(prisma).get(OrgId(DEFAULT_ORG_ID), providerId)

    let releaseChain: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      releaseChain = resolve
    })
    const order: string[] = []
    // Hold the provider's chain, exactly as an in-flight rebind does.
    const holder = serializeByProvider(DEFAULT_ORG_ID, provider!.name, async () => {
      await held
      order.push('rebind')
    })

    const disconnecting = app.app
      .inject({ method: 'POST', url: `${ORG}/mcp-providers/${providerId}/oauth/disconnect`, payload: {} })
      .then((r) => {
        order.push('disconnect')
        return r
      })

    // Give the request every chance to finish early; it must not, because it now queues.
    await new Promise((r) => setTimeout(r, 150))
    expect(order).toEqual([])

    releaseChain()
    await holder
    const res = await disconnecting
    expect(res.statusCode).toBe(204)
    // The disconnect ran strictly after the chain holder — never interleaved with it.
    expect(order).toEqual(['rebind', 'disconnect'])
  })

  it('disconnects without disturbing the provider or its agent-facing identity', async () => {
    const { app } = makeApp(fakeUpstream())
    const providerId = await createOauthProvider(app)
    await walk(app, providerId, '/api/v1')
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers/${providerId}/oauth/disconnect`,
      payload: {}
    })
    expect(res.statusCode).toBe(204)
    const after = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    const dto = after.json() as { url: string; oauth?: { status: string } }
    expect(dto.oauth?.status).toBe('pending')
    expect(dto.url).toBe(MCP_URL)
    expect(
      await new PgMcpProviderOauthSecretStore(prisma, new PlaintextSecretCipher()).get(
        OrgId(DEFAULT_ORG_ID),
        providerId
      )
    ).toMatchObject({ accessToken: null, refreshToken: null })
  })
})
