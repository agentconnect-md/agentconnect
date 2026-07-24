/**
 * The embedded OAuth 2.1 AS end-to-end (agent-assistant.md §7). The AS is hand-rolled
 * Fastify over `OAuthService` (the MCP SDK v2 dropped its embedded-AS helpers); the MCP
 * endpoint uses the SDK v2 web-standard handler. This suite drives the flow over a REAL
 * socket (listen + fetch) — a superset of what inject covers, and the shape a real
 * browser client uses. Endpoints: /oauth/{register,authorize,token} + consent at the
 * Fastify /api/v1/oauth/consent.
 *
 * The devAuth principal stands in for a logged-in console user; the flow: DCR →
 * /authorize (302 to consent) → consent mints a code → /token (PKCE) → the access token
 * drives the MCP endpoint → refresh → disconnect, plus the discovery docs, the scope
 * clamp, and the security rejections.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

interface Live {
  base: string
  app: HttpApp
  close(): Promise<void>
}
const opened: Live[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((l) => l.close()))
})

/** Build + listen on an ephemeral port for real-socket end-to-end coverage. */
async function start(configOverrides?: Parameters<typeof buildHttpApp>[1]): Promise<Live> {
  const app = buildHttpApp(prisma, configOverrides)
  const addr = await app.app.listen({ port: 0, host: '127.0.0.1' })
  const base = addr.replace('http://0.0.0.0', 'http://127.0.0.1').replace('[::1]', '127.0.0.1')
  const live: Live = { base, app, close: () => app.close() }
  opened.push(live)
  return live
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

async function req(
  base: string,
  method: string,
  path: string,
  opts: { json?: unknown; form?: Record<string, string>; bearer?: string } = {}
) {
  const headers: Record<string, string> = {}
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = form(opts.form)
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  const res = await fetch(`${base}${path}`, { method, headers, redirect: 'manual', ...(body ? { body } : {}) })
  const text = await res.text()
  return {
    status: res.status,
    location: res.headers.get('location'),
    wwwAuth: res.headers.get('www-authenticate'),
    text,
    json: () => JSON.parse(text)
  }
}

async function registerClient(base: string, redirectUris = [REDIRECT]): Promise<string> {
  const res = await req(base, 'POST', '/oauth/register', {
    json: { client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }
  })
  expect(res.status).toBe(201)
  return (res.json() as { client_id: string }).client_id
}

/** register → authorize → consent → token; returns the token response. */
async function fullFlow(base: string, opts: { scope?: string; orgId?: string } = {}) {
  const clientId = await registerClient(base)
  const { verifier, challenge } = pkce()

  const authz = await req(
    base,
    'GET',
    `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz${opts.scope ? `&scope=${encodeURIComponent(opts.scope)}` : ''}`
  )
  expect(authz.status).toBe(302)
  expect(authz.location).toContain('/oauth/consent')

  // The console (as the logged-in devAuth user) approves → our Fastify endpoint mints a code.
  const consent = await req(base, 'POST', '/api/v1/oauth/consent', {
    json: {
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      ...(opts.scope ? { scope: opts.scope } : {}),
      state: 'xyz',
      orgId: opts.orgId ?? DEFAULT_ORG_ID,
      decision: 'allow'
    }
  })
  expect(consent.status).toBe(200)
  const code = new URL((consent.json() as { redirectUrl: string }).redirectUrl).searchParams.get('code')!
  expect(code).toBeTruthy()

  const tok = await req(base, 'POST', '/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier
    }
  })
  return { clientId, verifier, tok }
}

interface Tokens {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

async function mcpWhoami(base: string, token: string, path = '/api/v1/mcp') {
  // The MCP streamable-HTTP transport requires this Accept header.
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
  })
  const text = await res.text()
  // The SDK v2 handler streams the JSON-RPC message over SSE (`event: message\ndata: {…}`).
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data:'))
  const raw = dataLine ? dataLine.slice(dataLine.indexOf(':') + 1).trim() : text
  return { status: res.status, json: () => (raw ? (JSON.parse(raw) as unknown) : null) }
}

describe('OAuth discovery metadata', () => {
  it('serves AS metadata (S256) + path-inserted PRM + root PRM fallback', async () => {
    const { base } = await start()
    const as = await req(base, 'GET', '/.well-known/oauth-authorization-server')
    expect(as.status).toBe(200)
    const asDoc = as.json() as {
      code_challenge_methods_supported: string[]
      registration_endpoint: string
      token_endpoint: string
    }
    expect(asDoc.code_challenge_methods_supported).toEqual(['S256'])
    expect(asDoc.registration_endpoint).toContain('/register')
    expect(asDoc.token_endpoint).toContain('/token')

    // Path-inserted at the PUBLIC `/v1/mcp` form — what a client derives from the URL
    // it was handed (MCP_PUBLIC_PATH); the internal `/api/v1` mount is not a public
    // discovery location.
    const prm = await req(base, 'GET', '/.well-known/oauth-protected-resource/v1/mcp')
    expect(prm.status).toBe(200)
    expect((prm.json() as { resource: string }).resource).toMatch(/\/v1\/mcp$/)

    const internal = await req(base, 'GET', '/.well-known/oauth-protected-resource/api/v1/mcp')
    expect(internal.status).toBe(404)

    const rootPrm = await req(base, 'GET', '/.well-known/oauth-protected-resource')
    expect(rootPrm.status).toBe(200)
  })

  it('the MCP 401 challenge points at the public-form PRM (auth-discovery entrance)', async () => {
    const { base } = await start()
    const res = await req(base, 'POST', '/api/v1/mcp', {
      json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    })
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('resource_metadata=')
    expect(res.wwwAuth).toContain('oauth-protected-resource/v1/mcp')
    expect(res.wwwAuth).not.toContain('oauth-protected-resource/api/v1/mcp')
  })

  it('the MCP wire serves at the public /v1 alias (direct-hit deploys dial the handed-out URL)', async () => {
    // Same dual-mount convention as the Slack/GitHub callbacks (#515): the public
    // `/v1/mcp` form must route without a rewriting edge in front.
    const { base } = await start()
    const unauthed = await req(base, 'POST', '/v1/mcp', {
      json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    })
    expect(unauthed.status).toBe(401)
    expect(unauthed.wwwAuth).toContain('oauth-protected-resource/v1/mcp')
  })

  it('PUBLIC_MCP_URL (dedicated MCP origin): root resource, origin-root PRM, and the AS all on that origin', async () => {
    // Deployed shape: the edge maps the MCP host's root onto the internal
    // /api/v1/mcp and forwards its /.well-known/* + /oauth/* verbatim — the WHOLE
    // OAuth surface (resource + AS) lives on the MCP origin; the api host serves
    // no OAuth. The CP's root PRM must carry the dedicated origin as resource AND
    // as the authorization server, the AS metadata must issue from it, and the 401
    // challenge must send clients to that origin's PRM.
    const { base } = await start({ PUBLIC_MCP_URL: 'https://mcp.example.test' })

    const prm = await req(base, 'GET', '/.well-known/oauth-protected-resource')
    expect(prm.status).toBe(200)
    const prmDoc = prm.json() as { resource: string; authorization_servers: string[] }
    // The bare origin, WITHOUT a trailing slash — the MCP spec's canonical-URI form
    // (2025-06-18 §Canonical Server URI: "use the form without the trailing slash"),
    // which is also what claude.ai stores for the connector and binds the token to. A
    // slashed value mismatches that and the client aborts at audience binding after the
    // token is issued (never presenting it to the endpoint).
    expect(prmDoc.resource).toBe('https://mcp.example.test')
    expect(prmDoc.authorization_servers).toEqual(['https://mcp.example.test'])

    const as = await req(base, 'GET', '/.well-known/oauth-authorization-server')
    expect(as.status).toBe(200)
    const asDoc = as.json() as { issuer: string; token_endpoint: string }
    expect(asDoc.issuer).toBe('https://mcp.example.test')
    expect(asDoc.token_endpoint).toBe('https://mcp.example.test/oauth/token')

    const res = await req(base, 'POST', '/api/v1/mcp', {
      json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    })
    expect(res.status).toBe(401)
    expect(res.wwwAuth).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"')
  })
})

describe('OAuth browser-login flow (happy path)', () => {
  it('register → authorize → consent → token → the access token drives MCP as the user', async () => {
    const { base } = await start()
    const { tok } = await fullFlow(base, { scope: 'mcp:read mcp:write' })
    expect(tok.status).toBe(200)
    const tokens = tok.json() as Tokens
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.expires_in).toBe(3600)
    expect(tokens.access_token.length).toBeGreaterThan(40)
    expect(tokens.refresh_token.length).toBeGreaterThan(40)
    expect(tokens.scope).toBe('mcp:read mcp:write')

    const who = await mcpWhoami(base, tokens.access_token)
    expect(who.status).toBe(200)
    const result = (who.json() as { result: { content: { text: string }[] } }).result
    expect((JSON.parse(result.content[0]!.text) as { user: { userId: string } }).user.userId).toBe(DEFAULT_OWNER_ID)

    // The same call through the public /v1 alias — the handed-out URL form.
    const whoPublic = await mcpWhoami(base, tokens.access_token, '/v1/mcp')
    expect(whoPublic.status).toBe(200)

    const row = await prisma.apiKey.findFirst({ where: { principalType: 'oauth' } })
    expect(row?.userId).toBe(DEFAULT_OWNER_ID)
    expect(row?.oauthGrantId).toBeTruthy()
  })

  it('DCR registers a PUBLIC client (no secret)', async () => {
    const { base } = await start()
    const res = await req(base, 'POST', '/oauth/register', {
      json: { client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }
    })
    expect(res.status).toBe(201)
    const client = res.json() as { client_id: string; client_secret?: string; token_endpoint_auth_method: string }
    expect(client.client_id).toMatch(/^mcp-/)
    expect(client.client_secret).toBeUndefined()
    expect(client.token_endpoint_auth_method).toBe('none')
  })
})

describe('OAuth refresh + disconnect', () => {
  it('refresh rotates the token and returns a fresh access token', async () => {
    const { base } = await start()
    const { clientId, tok } = await fullFlow(base)
    const first = tok.json() as Tokens

    const refreshed = await req(base, 'POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId }
    })
    expect(refreshed.status).toBe(200)
    const second = refreshed.json() as Tokens
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.access_token).not.toBe(first.access_token)
    expect((await mcpWhoami(base, second.access_token)).status).toBe(200)
  })

  it('disconnect (revoke grant) kills the access token immediately and blocks refresh', async () => {
    const { base } = await start()
    const { clientId, tok } = await fullFlow(base)
    const tokens = tok.json() as Tokens

    expect((await mcpWhoami(base, tokens.access_token)).status).toBe(200)
    const list = await req(base, 'GET', '/api/v1/oauth/grants')
    const grants = (list.json() as { grants: { id: string }[] }).grants
    expect(grants).toHaveLength(1)
    expect((await req(base, 'DELETE', `/api/v1/oauth/grants/${grants[0]!.id}`)).status).toBe(204)

    expect((await mcpWhoami(base, tokens.access_token)).status).toBe(401)
    const refreshed = await req(base, 'POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }
    })
    expect(refreshed.status).toBe(400)
    expect((refreshed.json() as { error: string }).error).toBe('invalid_grant')
  })
})

describe('OAuth security rejections', () => {
  it('requires interactive sign-in for consent and grant management', async () => {
    const { base } = await start()
    const accessToken = ((await fullFlow(base, { scope: 'mcp:read' })).tok.json() as Tokens).access_token
    const personalKeyResponse = await req(base, 'POST', '/api/v1/me/keys', {
      json: { orgId: DEFAULT_ORG_ID }
    })
    expect(personalKeyResponse.status).toBe(201)
    const personalKey = (personalKeyResponse.json() as { apiKey: string }).apiKey

    const grants = (await req(base, 'GET', '/api/v1/oauth/grants')).json() as {
      grants: { id: string }[]
    }
    expect(grants.grants).toHaveLength(1)
    const grantId = grants.grants[0]!.id

    const clientId = await registerClient(base)
    const { challenge } = pkce()
    const attempts = [
      {
        name: 'read consent context',
        run: (bearer: string) =>
          req(
            base,
            'GET',
            `/api/v1/oauth/consent/context?client_id=${clientId}&scope=${encodeURIComponent('mcp:read mcp:write')}`,
            { bearer }
          )
      },
      {
        name: 'approve broader scopes',
        run: (bearer: string) =>
          req(base, 'POST', '/api/v1/oauth/consent', {
            bearer,
            json: {
              clientId,
              redirectUri: REDIRECT,
              codeChallenge: challenge,
              codeChallengeMethod: 'S256',
              orgId: DEFAULT_ORG_ID,
              scope: 'mcp:read mcp:write',
              grantedScopes: ['mcp:read', 'mcp:write'],
              decision: 'allow'
            }
          })
      },
      {
        name: 'list grants',
        run: (bearer: string) => req(base, 'GET', '/api/v1/oauth/grants', { bearer })
      },
      {
        name: 'revoke a grant',
        run: (bearer: string) => req(base, 'DELETE', `/api/v1/oauth/grants/${grantId}`, { bearer })
      }
    ]

    for (const [credential, bearer] of [
      ['personal API key', personalKey],
      ['OAuth access token', accessToken]
    ] as const) {
      for (const attempt of attempts) {
        expect((await attempt.run(bearer)).status, `${credential} cannot ${attempt.name}`).toBe(403)
      }
    }

    // The rejected revoke did not damage the existing grant.
    expect((await mcpWhoami(base, accessToken)).status).toBe(200)
  })

  it('rejects an unregistered redirect_uri at /authorize (no open redirect)', async () => {
    const { base } = await start()
    const clientId = await registerClient(base)
    const { challenge } = pkce()
    const res = await req(
      base,
      'GET',
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example.com/steal')}&code_challenge=${challenge}&code_challenge_method=S256`
    )
    expect(res.status).toBe(400) // NOT a 302 to the attacker's URL
  })

  it('fails the token exchange on a wrong PKCE verifier', async () => {
    const { base } = await start()
    const clientId = await registerClient(base)
    const { challenge } = pkce()
    const consent = await req(base, 'POST', '/api/v1/oauth/consent', {
      json: {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        orgId: DEFAULT_ORG_ID,
        decision: 'allow'
      }
    })
    const code = new URL((consent.json() as { redirectUrl: string }).redirectUrl).searchParams.get('code')!
    const tok = await req(base, 'POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: 'the-wrong-verifier'
      }
    })
    expect(tok.status).toBe(400)
    expect((tok.json() as { error: string }).error).toBe('invalid_grant')
  })

  it('an authorization code is single-use (replay → invalid_grant)', async () => {
    const { base } = await start()
    const clientId = await registerClient(base)
    const { verifier, challenge } = pkce()
    const consent = await req(base, 'POST', '/api/v1/oauth/consent', {
      json: {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        orgId: DEFAULT_ORG_ID,
        decision: 'allow'
      }
    })
    const code = new URL((consent.json() as { redirectUrl: string }).redirectUrl).searchParams.get('code')!
    const exchange = () =>
      req(base, 'POST', '/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier
        }
      })
    expect((await exchange()).status).toBe(200)
    const replay = await exchange()
    expect(replay.status).toBe(400)
    expect((replay.json() as { error: string }).error).toBe('invalid_grant')
  })

  it('consent to an org the user does not belong to is refused (403)', async () => {
    const { base } = await start()
    const clientId = await registerClient(base)
    const { challenge } = pkce()
    const res = await req(base, 'POST', '/api/v1/oauth/consent', {
      json: {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        orgId: '00000000-0000-0000-0000-0000000000ff',
        decision: 'allow'
      }
    })
    expect(res.status).toBe(403)
  })

  it('DCR rejects a non-loopback http redirect_uri', async () => {
    const { base } = await start()
    const res = await req(base, 'POST', '/oauth/register', {
      json: { redirect_uris: ['http://evil.example.com/cb'], token_endpoint_auth_method: 'none' }
    })
    expect(res.status).toBe(400)
  })
})

describe('OAuth scope confinement (a mcp:read token cannot write via direct REST)', () => {
  it('read-only consent → GET works but org-resource writes are 403; write consent allows both', async () => {
    const { base } = await start()
    const readOnly = (await fullFlow(base, { scope: 'mcp:read' })).tok.json() as Tokens
    expect(readOnly.scope).toBe('mcp:read')

    expect(
      (await req(base, 'GET', `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`, { bearer: readOnly.access_token })).status
    ).toBe(200)
    const del = await req(
      base,
      'DELETE',
      `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/00000000-0000-0000-0000-0000000000aa`,
      { bearer: readOnly.access_token }
    )
    expect(del.status).toBe(403)

    const rw = (await fullFlow(base, { scope: 'mcp:read mcp:write' })).tok.json() as Tokens
    const del2 = await req(
      base,
      'DELETE',
      `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/00000000-0000-0000-0000-0000000000bb`,
      { bearer: rw.access_token }
    )
    expect(del2.status).not.toBe(403)
  })
})
