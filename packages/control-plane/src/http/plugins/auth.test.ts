import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebchatMcpGrantTokenCodec } from '../../registry/webchatMcpGrantToken.js'
import { INTERNAL_INVOCATION_AUTH_HEADER, InternalInvocationAuth } from '../mcp/internal-invocation-auth.js'
import type { InvocationContext } from '../mcp/remote-grant-authenticator.js'
import { humanAuthPlugin, type VerifyApiKey } from './auth.js'

const CONTEXT: InvocationContext = {
  invocationId: '11111111-1111-4111-8111-111111111111',
  grantId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '55555555-5555-4555-8555-555555555555',
  orgId: 'org-1',
  userId: 'user-1',
  startedAt: new Date(0)
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
