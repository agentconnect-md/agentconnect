import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebchatMcpGrantTokenCodec } from '../../registry/webchatMcpGrantToken.js'
import { INTERNAL_INVOCATION_AUTH_HEADER, InternalInvocationAuth } from '../mcp/internal-invocation-auth.js'
import type { InvocationContext } from '../mcp/remote-grant-authenticator.js'
import { humanAuthPlugin, type EnsureIdentityFresh, type HumanAuthOptions, type VerifyApiKey } from './auth.js'

const CONTEXT: InvocationContext = {
  invocationId: '11111111-1111-4111-8111-111111111111',
  grantId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  authorityGeneration: 1,
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '55555555-5555-4555-8555-555555555555',
  orgId: 'org-1',
  userId: 'user-1',
  startedAt: new Date(0),
  requestHash: '0'.repeat(64),
  method: 'tools/call'
}

const apps: ReturnType<typeof Fastify>[] = []

async function appWithAuth(internal: InternalInvocationAuth, verifyApiKey: VerifyApiKey) {
  const app = Fastify({ logger: false })
  apps.push(app)
  await app.register(humanAuthPlugin, {
    DEFAULT_OWNER_ID: 'dev-owner',
    verifyApiKey,
    internalInvocationAuth: internal
  })
  app.get('/api/v1/probe', { preHandler: app.humanAuth }, async (req) => ({
    principal: req.principal,
    apiKeyOrgId: req.apiKeyOrgId,
    apiKeyScopes: req.apiKeyScopes,
    delegatedInvocation: req.delegatedInvocation
  }))
  await app.ready()
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('humanAuthPlugin internal invocation seam', () => {
  it('authorizes an issued in-process nonce at the start of human auth and skips personal auth', async () => {
    const internal = new InternalInvocationAuth()
    const verifyApiKey = vi.fn<VerifyApiKey>(async () => {
      throw new Error('must not run')
    })
    const app = await appWithAuth(internal, verifyApiKey)

    const response = await internal.run(CONTEXT, async () => {
      const nonce = internal.issue('GET', '/api/v1/probe')!
      return app.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: {
          authorization: 'Bearer copied-network-credential',
          [INTERNAL_INVOCATION_AUTH_HEADER]: nonce
        }
      })
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      principal: { userId: CONTEXT.userId },
      apiKeyOrgId: CONTEXT.orgId,
      apiKeyScopes: ['mcp:read', 'mcp:write'],
      delegatedInvocation: {
        invocationId: CONTEXT.invocationId,
        grantId: CONTEXT.grantId,
        agentId: CONTEXT.agentId,
        conversationId: CONTEXT.conversationId
      }
    })
    expect(verifyApiKey).not.toHaveBeenCalled()
  })

  it('makes a copied internal header useless outside the issuing async-local run', async () => {
    const internal = new InternalInvocationAuth()
    const verifyApiKey = vi.fn<VerifyApiKey>(async () => null)
    const app = await appWithAuth(internal, verifyApiKey)
    let copied = ''
    await internal.run(CONTEXT, async () => {
      copied = internal.issue('GET', '/api/v1/probe')!
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: {
        authorization: 'Bearer copied-network-credential',
        [INTERNAL_INVOCATION_AUTH_HEADER]: copied
      }
    })

    expect(response.statusCode).toBe(401)
    expect(verifyApiKey).toHaveBeenCalledWith('copied-network-credential')
  })

  it('does not give unrelated inherited work authority without its own nonce', async () => {
    const internal = new InternalInvocationAuth()
    const verifyApiKey = vi.fn<VerifyApiKey>(async () => null)
    const app = await appWithAuth(internal, verifyApiKey)

    const response = await internal.run(CONTEXT, () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { authorization: 'Bearer unrelated-work' }
      })
    )

    expect(response.statusCode).toBe(401)
    expect(verifyApiKey).toHaveBeenCalledWith('unrelated-work')
  })

  it('never accepts a route assertion as general human authentication', async () => {
    const internal = new InternalInvocationAuth()
    const verifyApiKey = vi.fn<VerifyApiKey>(async () => null)
    const app = await appWithAuth(internal, verifyApiKey)
    const assertion = new WebchatMcpGrantTokenCodec('test-pepper-that-is-at-least-thirty-two-characters').mint()
      .plaintext

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${assertion}` }
    })

    expect(response.statusCode).toBe(401)
    expect(verifyApiKey).toHaveBeenCalledWith(assertion)
  })
})

/** An app with the given plugin options and one probed route behind humanAuth. */
async function appWithOptions(options: Partial<HumanAuthOptions>) {
  const app = Fastify({ logger: false })
  apps.push(app)
  await app.register(humanAuthPlugin, { DEFAULT_OWNER_ID: 'dev-owner', ...options })
  app.get('/api/v1/probe', { preHandler: app.humanAuth }, async (req) => ({ principal: req.principal }))
  await app.ready()
  return app
}

describe('humanAuthPlugin identity warm trigger (api-key path)', () => {
  const acceptKey: VerifyApiKey = async () => ({ userId: 'user-1', orgId: 'org-1', apiKeyId: 'key-1', scopes: [] })

  it('fires with the resolved principal after api-key auth (the trigger resolves the sub itself)', async () => {
    const warm = vi.fn<EnsureIdentityFresh>()
    const app = await appWithOptions({ verifyApiKey: acceptKey, ensureIdentityFresh: warm })

    const response = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { authorization: 'Bearer k3y' } })

    expect(response.statusCode).toBe(200)
    expect(warm).toHaveBeenCalledWith({ userId: 'user-1' })
  })

  it('does not fire when the api key is rejected', async () => {
    const warm = vi.fn<EnsureIdentityFresh>()
    const app = await appWithOptions({ verifyApiKey: async () => null, ensureIdentityFresh: warm })

    const response = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { authorization: 'Bearer bad' } })

    expect(response.statusCode).toBe(401)
    expect(warm).not.toHaveBeenCalled()
  })

  it('a throwing trigger never fails the request', async () => {
    const warm = vi.fn<EnsureIdentityFresh>(() => {
      throw new Error('warm exploded')
    })
    const app = await appWithOptions({ verifyApiKey: acceptKey, ensureIdentityFresh: warm })

    const response = await app.inject({ method: 'GET', url: '/api/v1/probe', headers: { authorization: 'Bearer k3y' } })

    expect(response.statusCode).toBe(200)
    expect(warm).toHaveBeenCalledTimes(1)
  })
})

describe('humanAuthPlugin identity warm trigger (oidc path)', () => {
  // A loopback OIDC issuer: discovery + JWKS, and a signer for bearers — the same
  // shape the OIDC integration tests use, without any database behind it.
  let oidcServer: Server
  let oidcIssuer = ''
  let mintBearer: (subject: string, claims?: Record<string, unknown>) => Promise<string>

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'warm-test', use: 'sig' }
    oidcServer = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/.well-known/openid-configuration') {
        res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: `${oidcIssuer}/jwks` }))
        return
      }
      if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((resolve, reject) => {
      oidcServer.once('error', reject)
      oidcServer.listen(0, '127.0.0.1', resolve)
    })
    const { port } = oidcServer.address() as AddressInfo
    oidcIssuer = `http://127.0.0.1:${port}`
    mintBearer = (subject, claims = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'warm-test' })
        .setIssuer(oidcIssuer)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey)
  })

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        oidcServer.close((err) => (err ? reject(err) : resolve()))
      })
  )

  it('fires with the local principal and the verified subject', async () => {
    const warm = vi.fn<EnsureIdentityFresh>()
    const app = await appWithOptions({
      OIDC_ISSUER: oidcIssuer,
      resolveUser: async ({ oidcSubject }) => ({ userId: `local-${oidcSubject}` }),
      ensureIdentityFresh: warm
    })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${await mintBearer('sub-42')}` }
    })

    expect(response.statusCode).toBe(200)
    expect(warm).toHaveBeenCalledWith({ userId: 'local-sub-42', oidcSubject: 'sub-42' })
  })

  it('surfaces the verified ADMIN role on the human principal', async () => {
    const app = await appWithOptions({ OIDC_ISSUER: oidcIssuer, resolveUser: async () => ({ userId: 'local-sub-42' }) })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${await mintBearer('sub-42', { roles: ['ADMIN'] })}` }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().principal).toEqual({ userId: 'local-sub-42', isAdmin: true })
  })

  it('a throwing trigger does not 401 a valid token', async () => {
    const warm = vi.fn<EnsureIdentityFresh>(() => {
      throw new Error('warm exploded')
    })
    const app = await appWithOptions({ OIDC_ISSUER: oidcIssuer, ensureIdentityFresh: warm })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${await mintBearer('sub-42')}` }
    })

    expect(response.statusCode).toBe(200)
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('does not fire when the bearer is rejected', async () => {
    const warm = vi.fn<EnsureIdentityFresh>()
    const app = await appWithOptions({ OIDC_ISSUER: oidcIssuer, ensureIdentityFresh: warm })

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: 'Bearer not.a.jwt' }
    })

    expect(response.statusCode).toBe(401)
    expect(warm).not.toHaveBeenCalled()
  })
})
