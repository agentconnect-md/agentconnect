import { describe, it, expect, vi } from 'vitest'
import { McpOauthDenied, McpProviderOauthService, normalizeReturnPath } from './service.js'
import { PlaintextSecretCipher } from '../secrets/cipher.js'
import { OrgId } from '../domain/ids.js'
import type { GuardedResult } from '../net/guarded-fetch.js'
import type { Dial } from './discovery.js'
import type {
  McpProviderOauthRecord,
  McpProviderOauthRepo,
  McpProviderOauthSecretStore,
  McpProviderOauthStateRecord,
  McpProviderOauthStateStore,
  McpProviderRecord,
  McpProviderRepo,
  PrepareMcpProviderOauthInput
} from '../persistence/ports.js'

const ORG = OrgId('org-1')
const PROVIDER = 'provider-1'
const USER = 'user-1'
const MCP_URL = 'https://mcp.example.test/mcp'
const ISSUER = 'https://auth.example.test'
const CP = 'https://cp.example.test'
const WEB = 'https://console.example.test'
const NOW = new Date('2026-09-14T12:00:00Z').getTime()
const CALLBACK = `${CP}/v1/mcp-providers/oauth/callback`
const PRM_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'

const ok = (status: number, json: unknown, headers: Record<string, string | string[]> = {}): GuardedResult => ({
  ok: true,
  response: { status, headers, text: JSON.stringify(json ?? null), json }
})

const AS_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  scopes_supported: ['files:read'],
  authorization_response_iss_parameter_supported: true
}

/** The full discovery + registration + token surface a happy funnel walks. */
function fakeDial(over: Record<string, GuardedResult> = {}) {
  const seen: Array<{ url: string; body?: string }> = []
  const table: Record<string, GuardedResult> = {
    [MCP_URL]: ok(401, undefined, {
      'www-authenticate': `Bearer resource_metadata="${PRM_URL}", scope="files:read"`
    }),
    [PRM_URL]: ok(200, {
      resource: MCP_URL,
      authorization_servers: [ISSUER],
      scopes_supported: ['files:read']
    }),
    'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, AS_DOC),
    [`${ISSUER}/register`]: ok(201, { client_id: 'dcr-id', client_secret: 'dcr-secret' }),
    [`${ISSUER}/token`]: ok(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    ...over
  }
  const dial = (async (url: string, init?: { body?: string }) => {
    seen.push({ url, ...(init?.body ? { body: init.body } : {}) })
    return table[url] ?? { ok: false, failure: 'unreachable' }
  }) as Dial
  return { dial, seen }
}

function fakeWorld(providerOver: Partial<McpProviderRecord> = {}) {
  const provider: McpProviderRecord = {
    id: PROVIDER,
    orgId: ORG,
    name: 'linear',
    kind: 'custom',
    auth: 'oauth2',
    ui: false,
    transport: 'http',
    url: MCP_URL,
    visibility: 'org',
    sharedWith: [],
    createdByUserId: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...providerOver
  }
  let row: McpProviderOauthRecord | null = null
  let secrets: { clientSecret: string | null; accessToken: string | null; refreshToken: string | null } | null = null
  const stateRows = new Map<string, McpProviderOauthStateRecord>()
  const connected: Array<{ providerId: string; accessExpiresAt: Date | null }> = []

  const providers = { get: async () => (providerOver.url === 'gone' ? null : provider) } as unknown as McpProviderRepo
  const oauth = {
    prepare: async (_o: OrgId, id: string, input: PrepareMcpProviderOauthInput) => {
      row = {
        mcpProviderId: id,
        resource: input.resource,
        issuer: input.issuer,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        registrationEndpoint: input.registrationEndpoint ?? null,
        scopes: input.scopes,
        clientId: input.clientId,
        clientSource: input.clientSource,
        issParameterSupported: input.issParameterSupported,
        status: 'pending',
        connectedByUserId: null,
        accessExpiresAt: null,
        tokenVersion: (row?.tokenVersion ?? 0n) + 1n,
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW)
      }
      secrets = { clientSecret: input.sealedClientSecret ?? null, accessToken: null, refreshToken: null }
      return row
    },
    get: async () => row,
    connect: async (_o: OrgId, id: string, input: { expectedVersion: bigint; accessExpiresAt: Date | null }) => {
      // The real repo's CAS: a callback whose generation has moved on commits nothing.
      if (row === null || input.expectedVersion !== row.tokenVersion) return false
      connected.push({ providerId: id, accessExpiresAt: input.accessExpiresAt })
      row = { ...row, status: 'connected', accessExpiresAt: input.accessExpiresAt, tokenVersion: row.tokenVersion + 1n }
      return true
    },
    disconnect: async () => {
      // Disconnect advances the generation, exactly as the repo does.
      if (row) row = { ...row, status: 'pending', tokenVersion: row.tokenVersion + 1n }
      return true
    }
  } as unknown as McpProviderOauthRepo
  const store: McpProviderOauthSecretStore = { get: async () => secrets }
  const states: McpProviderOauthStateStore = {
    put: async (r) => {
      stateRows.set(r.nonce, { ...r, browserHash: null })
    },
    bindBrowser: async (nonce, hash, now) => {
      const r = stateRows.get(nonce)
      if (!r || r.browserHash !== null || r.expiresAt <= now) return null
      const bound = { ...r, browserHash: hash }
      stateRows.set(nonce, bound)
      return bound
    },
    consume: async (nonce, now) => {
      const r = stateRows.get(nonce)
      stateRows.delete(nonce)
      return r && r.expiresAt > now ? r : null
    },
    reapExpired: async () => 0
  }
  return { providers, oauth, store, states, stateRows, connected, read: () => row }
}

function service(world: ReturnType<typeof fakeWorld>, dial: Dial, over: Record<string, unknown> = {}) {
  return new McpProviderOauthService({
    providers: world.providers,
    oauth: world.oauth,
    secrets: world.store,
    states: world.states,
    cipher: new PlaintextSecretCipher(),
    dial,
    clock: { now: () => NOW } as never,
    publicCpUrl: CP,
    webAppUrl: WEB,
    ...over
  })
}

/** start → begin → callback, returning what each hop produced. */
async function walk(world: ReturnType<typeof fakeWorld>, dial: Dial, svc = service(world, dial)) {
  const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
  const nonce = new URL(url).searchParams.get('state')!
  const begun = await svc.begin(nonce)
  const authorize = new URL(begun!.redirectUrl)
  const result = await svc.callback({
    state: nonce,
    code: 'code-1',
    iss: ISSUER,
    error: undefined,
    browserNonce: begun!.browserNonce
  })
  return { svc, nonce, begun, authorize, result }
}

describe('normalizeReturnPath', () => {
  it('accepts a local console path and defaults to root', () => {
    expect(normalizeReturnPath(undefined)).toBe('/')
    expect(normalizeReturnPath('/tools?tab=mcp')).toBe('/tools?tab=mcp')
  })

  it.each(['https://evil.example.test', '//evil.example.test', '/a\\b', `/${'x'.repeat(600)}`])(
    'refuses %s',
    (path) => {
      expect(() => normalizeReturnPath(path)).toThrow(McpOauthDenied)
    }
  )
})

describe('McpProviderOauthService — the happy funnel', () => {
  it('discovers, registers, and hands back a begin url on the public CP origin', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const { url } = await service(world, dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    expect(url.startsWith(`${CP}/v1/mcp-providers/oauth/begin?state=`)).toBe(true)
    expect(world.read()).toMatchObject({
      issuer: ISSUER,
      resource: MCP_URL,
      clientId: 'dcr-id',
      clientSource: 'dynamic',
      issParameterSupported: true,
      status: 'pending'
    })
  })

  it('redirects to the authorization server with PKCE, the resource, and the challenge scope', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const { authorize } = await walk(world, dial)
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('resource')).toBe(MCP_URL)
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK)
    expect(authorize.searchParams.get('scope')).toBe('files:read')
  })

  it('redeems the code and commits the grant, then notifies the binding push', async () => {
    const world = fakeWorld()
    const { dial, seen } = fakeDial()
    const onConnected = vi.fn(async () => {})
    const svc = service(world, dial, { onConnected })
    const { result } = await walk(world, dial, svc)
    expect(result).toEqual({ redirectPath: '/tools', result: 'connected' })
    expect(world.connected).toEqual([{ providerId: PROVIDER, accessExpiresAt: new Date(NOW + 3600_000) }])
    expect(onConnected).toHaveBeenCalledWith(ORG, PROVIDER)
    const tokenBody = new URLSearchParams(seen.find((s) => s.url === `${ISSUER}/token`)!.body!)
    expect(tokenBody.get('grant_type')).toBe('authorization_code')
    expect(tokenBody.get('resource')).toBe(MCP_URL)
    expect(tokenBody.get('redirect_uri')).toBe(CALLBACK)
  })

  it('lands the browser back on the console origin carrying the outcome', () => {
    const svc = service(fakeWorld(), fakeDial().dial)
    expect(svc.redirectTarget('/tools', 'connected')).toBe(`${WEB}/tools?mcpOauth=connected`)
    expect(svc.redirectTarget('/tools?tab=mcp', 'browser_mismatch')).toBe(
      `${WEB}/tools?tab=mcp&mcpOauth=browser_mismatch`
    )
  })
})

describe('McpProviderOauthService — start refusals', () => {
  it('refuses a deployment with no public CP origin rather than guessing one', async () => {
    const world = fakeWorld()
    const svc = service(world, fakeDial().dial, { publicCpUrl: undefined })
    await expect(svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER })).rejects.toMatchObject({
      reason: 'cp_public_url_missing'
    })
  })

  it('refuses a provider that is not an oauth2 row', async () => {
    const world = fakeWorld({ auth: 'headers' })
    await expect(
      service(world, fakeDial().dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    ).rejects.toMatchObject({ reason: 'provider_not_oauth' })
  })

  it('surfaces a discovery failure as itself, so the console can tell why', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial({
      [MCP_URL]: ok(200, { jsonrpc: '2.0', id: 0, result: {} }),
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(404, undefined),
      'https://mcp.example.test/.well-known/oauth-protected-resource': ok(404, undefined)
    })
    await expect(service(world, dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })).rejects.toMatchObject({
      reason: 'discovery_not_protected'
    })
  })

  it('has nothing to register with when the server offers no registration endpoint', async () => {
    const world = fakeWorld()
    const { registration_endpoint: _drop, ...withoutRegistration } = AS_DOC
    const { dial } = fakeDial({
      'https://auth.example.test/.well-known/oauth-authorization-server': ok(200, withoutRegistration)
    })
    await expect(service(world, dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })).rejects.toMatchObject({
      reason: 'no_client_registration'
    })
  })

  it('uses operator-supplied credentials instead of registering', async () => {
    const world = fakeWorld()
    const { dial, seen } = fakeDial()
    await service(world, dial).start({
      orgId: ORG,
      providerId: PROVIDER,
      userId: USER,
      clientId: 'manual-id',
      clientSecret: 'manual-secret'
    })
    expect(world.read()).toMatchObject({ clientId: 'manual-id', clientSource: 'preregistered' })
    expect(seen.some((s) => s.url === `${ISSUER}/register`)).toBe(false)
  })

  it('reuses the client it already registered with the same issuer', async () => {
    const world = fakeWorld()
    const { dial, seen } = fakeDial()
    const svc = service(world, dial)
    await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    expect(seen.filter((s) => s.url === `${ISSUER}/register`)).toHaveLength(1)
    expect(world.read()).toMatchObject({ clientId: 'dcr-id', clientSource: 'dynamic' })
  })

  it('re-registers when the resource has moved to a different authorization server', async () => {
    const world = fakeWorld()
    const first = fakeDial()
    await service(world, first.dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    const moved = 'https://auth2.example.test'
    const second = fakeDial({
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp': ok(200, {
        resource: MCP_URL,
        authorization_servers: [moved]
      }),
      'https://auth2.example.test/.well-known/oauth-authorization-server': ok(200, {
        ...AS_DOC,
        issuer: moved,
        authorization_endpoint: `${moved}/authorize`,
        token_endpoint: `${moved}/token`,
        registration_endpoint: `${moved}/register`
      }),
      [`${moved}/register`]: ok(201, { client_id: 'dcr-id-2' })
    })
    await service(world, second.dial).start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    expect(second.seen.some((s) => s.url === `${moved}/register`)).toBe(true)
    expect(world.read()).toMatchObject({ issuer: moved, clientId: 'dcr-id-2' })
  })
})

describe('McpProviderOauthService — callback validation', () => {
  it('binds the browser exactly once, so a replayed begin link gets nothing', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER })
    const nonce = new URL(url).searchParams.get('state')!
    expect(await svc.begin(nonce)).not.toBeNull()
    expect(await svc.begin(nonce)).toBeNull()
  })

  it('reads an unknown, expired or already-consumed state the same way', async () => {
    const world = fakeWorld()
    const svc = service(world, fakeDial().dial)
    expect(
      await svc.callback({ state: undefined, code: 'c', iss: ISSUER, error: undefined, browserNonce: 'b' })
    ).toEqual({ redirectPath: '/', result: 'state_invalid' })
    expect(
      await svc.callback({ state: 'never-issued', code: 'c', iss: ISSUER, error: undefined, browserNonce: 'b' })
    ).toEqual({ redirectPath: '/', result: 'state_invalid' })
  })

  it('refuses a callback arriving in a different browser', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const nonce = new URL(url).searchParams.get('state')!
    await svc.begin(nonce)
    expect(
      await svc.callback({ state: nonce, code: 'c', iss: ISSUER, error: undefined, browserNonce: 'someone-else' })
    ).toEqual({ redirectPath: '/tools', result: 'browser_mismatch' })
  })

  it.each([
    ['a different issuer', 'https://evil.example.test'],
    ['no issuer at all from a server that advertises one', undefined]
  ])('refuses a response carrying %s', async (_name, iss) => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const nonce = new URL(url).searchParams.get('state')!
    const begun = await svc.begin(nonce)
    expect(
      await svc.callback({ state: nonce, code: 'c', iss, error: undefined, browserNonce: begun!.browserNonce })
    ).toEqual({ redirectPath: '/tools', result: 'issuer_mismatch' })
    expect(world.connected).toHaveLength(0)
  })

  it('validates the issuer before acting on an error response', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const nonce = new URL(url).searchParams.get('state')!
    const begun = await svc.begin(nonce)
    expect(
      await svc.callback({
        state: nonce,
        code: undefined,
        iss: 'https://evil.example.test',
        error: 'access_denied',
        browserNonce: begun!.browserNonce
      })
    ).toEqual({ redirectPath: '/tools', result: 'issuer_mismatch' })
  })

  it('reports a declined authorization as its own outcome', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const nonce = new URL(url).searchParams.get('state')!
    const begun = await svc.begin(nonce)
    expect(
      await svc.callback({
        state: nonce,
        code: undefined,
        iss: ISSUER,
        error: 'access_denied',
        browserNonce: begun!.browserNonce
      })
    ).toEqual({ redirectPath: '/tools', result: 'authorization_denied' })
  })

  it('refuses a grant with no refresh token rather than storing one that dies at first expiry', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial({ [`${ISSUER}/token`]: ok(200, { access_token: 'a1', expires_in: 3600 }) })
    const { result } = await walk(world, dial)
    expect(result).toEqual({ redirectPath: '/tools', result: 'no_refresh_token' })
    expect(world.connected).toHaveLength(0)
  })

  it('does not resurrect a grant that was disconnected while the exchange was in flight', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const { url } = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const nonce = new URL(url).searchParams.get('state')!
    const begun = await svc.begin(nonce)
    // The operator disconnects before the authorization server's response comes back.
    await world.oauth.disconnect(ORG, PROVIDER)
    const result = await svc.callback({
      state: nonce,
      code: 'code-1',
      iss: ISSUER,
      error: undefined,
      browserNonce: begun!.browserNonce
    })
    expect(result).toEqual({ redirectPath: '/tools', result: 'superseded' })
    expect(world.connected).toHaveLength(0)
    expect(world.read()?.status).toBe('pending')
  })

  it('does not let an older callback overwrite a newer authorization attempt', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial()
    const svc = service(world, dial)
    const first = await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const firstNonce = new URL(first.url).searchParams.get('state')!
    const firstBegun = await svc.begin(firstNonce)
    // A second attempt re-prepares the provider, advancing the generation.
    await svc.start({ orgId: ORG, providerId: PROVIDER, userId: USER, returnPath: '/tools' })
    const stale = await svc.callback({
      state: firstNonce,
      code: 'code-1',
      iss: ISSUER,
      error: undefined,
      browserNonce: firstBegun!.browserNonce
    })
    expect(stale).toEqual({ redirectPath: '/tools', result: 'superseded' })
    expect(world.connected).toHaveLength(0)
  })

  it('reports a refused code exchange without connecting', async () => {
    const world = fakeWorld()
    const { dial } = fakeDial({ [`${ISSUER}/token`]: ok(400, { error: 'invalid_grant' }) })
    const { result } = await walk(world, dial)
    expect(result).toEqual({ redirectPath: '/tools', result: 'exchange_failed' })
    expect(world.connected).toHaveLength(0)
  })
})
