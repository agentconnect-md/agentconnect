import { describe, it, expect } from 'vitest'
import type { GuardedResult } from '../net/guarded-fetch.js'
import {
  authServerMetadataUrls,
  bearerChallenge,
  discoverAuthServer,
  discoverMcpAuthorization,
  discoverProtectedResource,
  issuerEquivalent,
  parseWwwAuthenticate,
  probeMcpEndpoint,
  protectedResourceMetadataUrls,
  resourceCovers,
  sameResource,
  selectScopes,
  type AuthServerMetadata,
  type Dial,
  type ProtectedResourceMetadata
} from './discovery.js'

const MCP_URL = 'https://mcp.example.test/mcp'
const ISSUER = 'https://auth.example.test'

function ok(status: number, json: unknown, headers: Record<string, string | string[]> = {}): GuardedResult {
  return { ok: true, response: { status, headers, text: JSON.stringify(json ?? null), json } }
}

/** A dial over a fixed url→result table, recording the order urls were tried in. */
function fakeDial(table: Record<string, GuardedResult>): Dial & { tried: string[] } {
  const tried: string[] = []
  const dial = ((url: string) => {
    tried.push(url)
    return Promise.resolve(table[url] ?? { ok: false, failure: 'unreachable' })
  }) as Dial & { tried: string[] }
  dial.tried = tried
  return dial
}

const CHALLENGE = {
  'www-authenticate': `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="files:read files:write"`
}

const PRM_DOC = {
  resource: MCP_URL,
  authorization_servers: [ISSUER],
  scopes_supported: ['files:read']
}

const AS_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  scopes_supported: ['files:read', 'files:write', 'offline_access'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true
}

describe('parseWwwAuthenticate', () => {
  it('reads a Bearer challenge with quoted params', () => {
    expect(parseWwwAuthenticate('Bearer resource_metadata="https://a.test/x", scope="a b"')).toEqual([
      { scheme: 'bearer', params: { resource_metadata: 'https://a.test/x', scope: 'a b' } }
    ])
  })

  it('keeps a comma inside a quoted value instead of splitting on it', () => {
    const parsed = parseWwwAuthenticate('Bearer error="invalid_token", error_description="expired, re-authorize"')
    expect(parsed[0]?.params.error_description).toBe('expired, re-authorize')
  })

  it('separates several challenges and is case-insensitive about scheme and param names', () => {
    const parsed = parseWwwAuthenticate('Basic realm="x", BEARER Scope="a", error=insufficient_scope')
    expect(parsed.map((c) => c.scheme)).toEqual(['basic', 'bearer'])
    expect(parsed[1]?.params).toEqual({ scope: 'a', error: 'insufficient_scope' })
  })

  it('unescapes a quoted-pair and tolerates an unterminated quote', () => {
    expect(parseWwwAuthenticate('Bearer realm="a\\"b"')[0]?.params.realm).toBe('a"b')
    expect(parseWwwAuthenticate('Bearer realm="unterminated')[0]?.params.realm).toBe('unterminated')
  })

  it('picks the Bearer challenge out of a joined multi-value header', () => {
    expect(bearerChallenge(['Basic realm="x"', 'Bearer scope="a"'])).toEqual({ scope: 'a' })
    expect(bearerChallenge(undefined)).toBeNull()
    expect(bearerChallenge('Basic realm="x"')).toBeNull()
  })
})

describe('sameResource', () => {
  it('ignores a single trailing slash and scheme/host case', () => {
    expect(sameResource('https://mcp.example.test/mcp/', MCP_URL)).toBe(true)
    expect(sameResource('HTTPS://MCP.EXAMPLE.TEST/mcp', MCP_URL)).toBe(true)
    expect(sameResource('https://mcp.example.test', 'https://mcp.example.test/')).toBe(true)
  })

  it('still separates different paths, hosts and schemes', () => {
    expect(sameResource('https://mcp.example.test/other', MCP_URL)).toBe(false)
    expect(sameResource('https://evil.example.test/mcp', MCP_URL)).toBe(false)
    expect(sameResource('http://mcp.example.test/mcp', MCP_URL)).toBe(false)
    expect(sameResource('not a url', MCP_URL)).toBe(false)
  })
})

describe('resourceCovers', () => {
  it('accepts the url itself, its origin, and a parent path at a segment boundary', () => {
    expect(resourceCovers(MCP_URL, MCP_URL)).toBe(true)
    expect(resourceCovers('https://mcp.example.test', MCP_URL)).toBe(true) // Front, and most hosted servers
    expect(resourceCovers('https://mcp.example.test/', MCP_URL)).toBe(true)
    expect(resourceCovers('https://MCP.example.test', 'https://mcp.example.test/v1/tenant/mcp')).toBe(true)
    expect(resourceCovers('https://mcp.example.test/v1', 'https://mcp.example.test/v1/tenant/mcp')).toBe(true)
    expect(resourceCovers('https://mcp.example.test/v1/', 'https://mcp.example.test/v1/tenant/mcp')).toBe(true)
  })

  it('still refuses another host, scheme, port, a sibling path, or a partial segment', () => {
    expect(resourceCovers('https://evil.example.test', MCP_URL)).toBe(false)
    expect(resourceCovers('http://mcp.example.test', MCP_URL)).toBe(false)
    expect(resourceCovers('https://mcp.example.test:8443', MCP_URL)).toBe(false)
    expect(resourceCovers('https://mcp.example.test/other', MCP_URL)).toBe(false)
    expect(resourceCovers('https://mcp.example.test/m', MCP_URL)).toBe(false)
    expect(resourceCovers('https://mcp.example.test/mcp/deeper', MCP_URL)).toBe(false)
    expect(resourceCovers('https://mcp.example.test?tenant=a', MCP_URL)).toBe(false)
    expect(resourceCovers('not a url', MCP_URL)).toBe(false)
  })
})

describe('well-known url ordering', () => {
  it('puts the path-inserted protected-resource location before the root one', () => {
    expect(protectedResourceMetadataUrls('https://example.test/public/mcp')).toEqual([
      'https://example.test/.well-known/oauth-protected-resource/public/mcp',
      'https://example.test/.well-known/oauth-protected-resource'
    ])
  })

  it('has only the root location when the resource is at the origin root', () => {
    expect(protectedResourceMetadataUrls('https://example.test/')).toEqual([
      'https://example.test/.well-known/oauth-protected-resource'
    ])
  })

  it('tries RFC 8414 path-insertion, then OIDC insertion, then OIDC appending', () => {
    expect(authServerMetadataUrls('https://auth.example.test/tenant1')).toEqual([
      'https://auth.example.test/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.test/.well-known/openid-configuration/tenant1',
      'https://auth.example.test/tenant1/.well-known/openid-configuration'
    ])
  })

  it('tries RFC 8414 then OIDC for a path-less issuer', () => {
    expect(authServerMetadataUrls(ISSUER)).toEqual([
      'https://auth.example.test/.well-known/oauth-authorization-server',
      'https://auth.example.test/.well-known/openid-configuration'
    ])
  })
})

describe('probeMcpEndpoint', () => {
  it('POSTs an initialize and reports the Bearer challenge', async () => {
    const dial = fakeDial({ [MCP_URL]: ok(401, undefined, CHALLENGE) })
    const result = await probeMcpEndpoint(dial, MCP_URL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.status).toBe(401)
    expect(result.value.challenge?.scope).toBe('files:read files:write')
  })

  it('reports an unreachable endpoint distinctly from a malformed one', async () => {
    expect(await probeMcpEndpoint(fakeDial({}), MCP_URL)).toEqual({ ok: false, failure: 'discovery_unreachable' })
  })
})

describe('discoverProtectedResource', () => {
  it('follows the challenge pointer without probing the well-known locations', async () => {
    const pointer = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
    const dial = fakeDial({ [pointer]: ok(200, PRM_DOC) })
    const result = await discoverProtectedResource(dial, MCP_URL, bearerChallenge(CHALLENGE['www-authenticate']))
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ resource: MCP_URL }) })
    expect(dial.tried).toEqual([pointer])
  })

  it('falls back to the well-known order when no challenge named one', async () => {
    const dial = fakeDial({ 'https://mcp.example.test/.well-known/oauth-protected-resource': ok(200, PRM_DOC) })
    const result = await discoverProtectedResource(dial, MCP_URL, null)
    expect(result.ok).toBe(true)
    expect(dial.tried).toEqual([
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      'https://mcp.example.test/.well-known/oauth-protected-resource'
    ])
  })

  it('accepts a published resource that differs only by a trailing slash', async () => {
    const dial = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(200, {
        ...PRM_DOC,
        resource: `${MCP_URL}/`
      })
    })
    const result = await discoverProtectedResource(dial, MCP_URL, null)
    expect(result.ok).toBe(true)
    // The PUBLISHED string survives verbatim — it is what the RFC 8707 `resource` sends.
    if (result.ok) expect(result.value.resource).toBe(`${MCP_URL}/`)
  })

  it('refuses metadata describing a different resource', async () => {
    const dial = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(200, {
        ...PRM_DOC,
        resource: 'https://evil.example.test/mcp'
      })
    })
    expect(await discoverProtectedResource(dial, MCP_URL, null)).toEqual({ ok: false, failure: 'resource_mismatch' })
  })

  it('accepts a document whose resource is the origin of the registered url', async () => {
    // Front's server: the challenge points at the ROOT document, which names the origin.
    const dial = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource': ok(200, {
        resource: 'https://mcp.example.test',
        authorization_servers: [ISSUER]
      })
    })
    expect(
      await discoverProtectedResource(dial, MCP_URL, {
        resource_metadata: 'https://mcp.example.test/.well-known/oauth-protected-resource'
      })
    ).toEqual({ ok: true, value: { resource: 'https://mcp.example.test', authorizationServers: [ISSUER] } })
  })

  it('refuses metadata with no authorization server', async () => {
    const dial = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(200, {
        resource: MCP_URL,
        authorization_servers: []
      })
    })
    expect(await discoverProtectedResource(dial, MCP_URL, null)).toEqual({ ok: false, failure: 'discovery_malformed' })
  })

  it('says not-protected when every well-known location 404s', async () => {
    const dial = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(404, undefined),
      'https://mcp.example.test/.well-known/oauth-protected-resource': ok(404, undefined)
    })
    expect(await discoverProtectedResource(dial, MCP_URL, null)).toEqual({
      ok: false,
      failure: 'discovery_not_protected'
    })
  })
})

describe('discoverAuthServer', () => {
  it('takes the first metadata document that answers', async () => {
    const dial = fakeDial({ 'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, AS_DOC) })
    const result = await discoverAuthServer(dial, ISSUER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tokenEndpoint).toBe(`${ISSUER}/token`)
    expect(result.value.issParameterSupported).toBe(true)
    expect(result.value.clientIdMetadataDocumentSupported).toBe(false)
  })

  it('falls through to the OIDC location when the RFC 8414 one is absent', async () => {
    const dial = fakeDial({ 'https://auth.example.test/.well-known/openid-configuration': ok(200, AS_DOC) })
    expect((await discoverAuthServer(dial, ISSUER)).ok).toBe(true)
    expect(dial.tried).toEqual([
      'https://auth.example.test/.well-known/oauth-authorization-server',
      'https://auth.example.test/.well-known/openid-configuration'
    ])
  })

  it('rejects a document claiming an issuer it was not fetched for, and stops trying', async () => {
    const dial = fakeDial({
      'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, {
        ...AS_DOC,
        issuer: 'https://honest.example.test'
      }),
      'https://auth.example.test/.well-known/openid-configuration': ok(200, AS_DOC)
    })
    expect(await discoverAuthServer(dial, ISSUER)).toEqual({ ok: false, failure: 'issuer_mismatch' })
    expect(dial.tried).toHaveLength(1)
  })

  it('accepts a path-less issuer that differs only by its trailing slash (Google spells the two differently)', async () => {
    const dial = fakeDial({
      'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, { ...AS_DOC, issuer: `${ISSUER}/` })
    })
    const result = await discoverAuthServer(dial, ISSUER)
    expect(result.ok).toBe(true)
    // The document's own spelling is what the flow keeps: it is what `iss` responses will carry.
    if (result.ok) expect(result.value.issuer).toBe(`${ISSUER}/`)
    expect(
      await discoverAuthServer(
        fakeDial({
          'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, AS_DOC)
        }),
        `${ISSUER}/`
      )
    ).toMatchObject({ ok: true })
  })

  it('still treats every other issuer difference as a mismatch', () => {
    expect(issuerEquivalent(ISSUER, ISSUER)).toBe(true)
    expect(issuerEquivalent(`${ISSUER}/`, ISSUER)).toBe(true)
    expect(issuerEquivalent(`${ISSUER}/tenant/`, `${ISSUER}/tenant`)).toBe(false)
    expect(issuerEquivalent(`${ISSUER}/tenant`, ISSUER)).toBe(false)
    expect(issuerEquivalent('https://other.example.test/', ISSUER)).toBe(false)
    expect(issuerEquivalent('http://auth.example.test/', ISSUER)).toBe(false)
    expect(issuerEquivalent('https://auth.example.test:8443/', ISSUER)).toBe(false)
    expect(issuerEquivalent(`${ISSUER}/?x=1`, ISSUER)).toBe(false)
    expect(issuerEquivalent('not a url', ISSUER)).toBe(false)
  })

  it('rejects a document missing a required endpoint', async () => {
    const dial = fakeDial({
      'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`
      })
    })
    expect(await discoverAuthServer(dial, ISSUER)).toEqual({ ok: false, failure: 'discovery_malformed' })
  })
})

describe('selectScopes', () => {
  const prm: ProtectedResourceMetadata = { resource: MCP_URL, authorizationServers: [ISSUER], scopesSupported: ['a'] }
  const as: AuthServerMetadata = {
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    issParameterSupported: false,
    clientIdMetadataDocumentSupported: false
  }

  it('treats the challenge scope as authoritative over scopes_supported', () => {
    expect(selectScopes({ scope: 'x y' }, prm, as)).toEqual(['x', 'y'])
  })

  it('falls back to the resource scopes_supported, then to nothing', () => {
    expect(selectScopes(null, prm, as)).toEqual(['a'])
    expect(selectScopes(null, { resource: MCP_URL, authorizationServers: [ISSUER] }, as)).toEqual([])
  })

  it('asks for offline_access only when the authorization server advertises it', () => {
    expect(selectScopes({ scope: 'x' }, prm, { ...as, scopesSupported: ['x', 'offline_access'] })).toEqual([
      'x',
      'offline_access'
    ])
    expect(selectScopes({ scope: 'x' }, prm, { ...as, scopesSupported: ['x'] })).toEqual(['x'])
  })
})

describe('discoverMcpAuthorization', () => {
  it('walks probe → protected resource → authorization server and reports the audience and scopes', async () => {
    const dial = fakeDial({
      [MCP_URL]: ok(401, undefined, CHALLENGE),
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(200, PRM_DOC),
      'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, AS_DOC)
    })
    const result = await discoverMcpAuthorization(dial, MCP_URL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.resource).toBe(MCP_URL)
    expect(result.value.scopes).toEqual(['files:read', 'files:write', 'offline_access'])
    expect(result.value.metadata.registrationEndpoint).toBe(`${ISSUER}/register`)
  })

  it('surfaces the first failure in the chain', async () => {
    const dial = fakeDial({ [MCP_URL]: ok(200, { jsonrpc: '2.0', id: 0, result: {} }) })
    expect(await discoverMcpAuthorization(dial, MCP_URL)).toEqual({ ok: false, failure: 'discovery_unreachable' })
  })
})
