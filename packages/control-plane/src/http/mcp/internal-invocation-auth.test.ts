import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import {
  INTERNAL_INVOCATION_AUTH_HEADER,
  InternalInvocationAuth,
  type InvocationContextState
} from './internal-invocation-auth.js'
import type { InvocationContext } from './remote-grant-authenticator.js'

const CONTEXT: InvocationContext = {
  invocationId: '11111111-1111-4111-8111-111111111111',
  grantId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  authorityGeneration: 1,
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '55555555-5555-4555-8555-555555555555',
  orgId: 'org-1',
  userId: 'user-1',
  startedAt: new Date('2026-07-30T00:00:00.000Z'),
  requestHash: '0'.repeat(64),
  method: 'tools/call'
}

function request(nonce?: string | null, method = 'GET', url = '/api/v1/me'): FastifyRequest {
  return {
    method,
    url,
    headers: nonce ? { [INTERNAL_INVOCATION_AUTH_HEADER]: nonce } : {}
  } as unknown as FastifyRequest
}

describe('InternalInvocationAuth', () => {
  it('creates an isolated AsyncLocalStorage<InvocationContextState> run boundary', async () => {
    const auth = new InternalInvocationAuth()

    expect(() => auth.issue('GET', '/api/v1/me')).toThrow(/active invocation context/)
    await auth.run(CONTEXT, async () => {
      expect(auth.issue('GET', '/api/v1/me')).toEqual(expect.any(String))
    })
    expect(() => auth.issue('GET', '/api/v1/me')).toThrow(/active invocation context/)

    const typeCheck: InvocationContextState = {
      context: CONTEXT,
      pending: new Map(),
      active: true
    }
    expect(typeCheck.context).toBe(CONTEXT)
  })

  it('closes inherited detached work before it can mint after run resolves', async () => {
    const auth = new InternalInvocationAuth()
    let detachedAttempt!: Promise<unknown>

    await auth.run(CONTEXT, async () => {
      detachedAttempt = new Promise((resolve) => {
        setImmediate(() => {
          try {
            resolve(auth.issue('GET', '/api/v1/me'))
          } catch (error) {
            resolve(error)
          }
        })
      })
    })

    await expect(detachedAttempt).resolves.toBeInstanceOf(Error)
  })

  it('revokes an active run immediately, clears pending nonces, and prevents later issuance', async () => {
    const auth = new InternalInvocationAuth()
    let pendingNonce = ''
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    const execution = auth.start(CONTEXT, async () => {
      pendingNonce = auth.issue('GET', '/api/v1/me')!
      startedResolve()
      await gate
      return auth.issue('DELETE', '/api/v1/orgs/org-1/agents/target')
    })
    await started

    execution.revoke()
    expect(auth.authorizeInjectedRequest(request(pendingNonce))).toBe(false)
    release()
    await expect(execution.result).rejects.toThrow(/active invocation context/)
  })

  it('rejects a nonce consumed by an inherited descendant after run resolves without projecting authority', async () => {
    const auth = new InternalInvocationAuth()
    let releaseDetached!: () => void
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve
    })
    let detachedAttempt!: Promise<{ authorized: boolean; req: FastifyRequest }>

    await auth.run(CONTEXT, async () => {
      const nonce = auth.issue('GET', '/api/v1/me')
      detachedAttempt = (async () => {
        await detachedGate
        const req = request(nonce)
        return { authorized: auth.authorizeInjectedRequest(req), req }
      })()
    })
    releaseDetached()

    const { authorized, req } = await detachedAttempt
    expect(authorized).toBe(false)
    expect(req.principal).toBeUndefined()
    expect(req.apiKeyOrgId).toBeUndefined()
    expect(req.apiKeyScopes).toBeUndefined()
    expect(req.delegatedInvocation).toBeUndefined()
  })

  it('closes inherited descendants when the run callback rejects', async () => {
    const auth = new InternalInvocationAuth()
    let releaseDetached!: () => void
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve
    })
    let detachedAttempt!: Promise<unknown>

    await expect(
      auth.run(CONTEXT, async () => {
        detachedAttempt = (async () => {
          await detachedGate
          try {
            return auth.issue('GET', '/api/v1/me')
          } catch (error) {
            return error
          }
        })()
        throw new Error('callback failed')
      })
    ).rejects.toThrow('callback failed')
    releaseDetached()

    await expect(detachedAttempt).resolves.toBeInstanceOf(Error)
  })

  it('issues cryptographically opaque independent nonces to parallel subrequests', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      const [left, right] = await Promise.all([
        Promise.resolve(auth.issue('GET', '/api/v1/me')),
        Promise.resolve(auth.issue('GET', '/api/v1/orgs/org-1'))
      ])

      expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(right).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(left).not.toBe(right)
      expect(auth.authorizeInjectedRequest(request(left!, 'GET', '/api/v1/me'))).toBe(true)
      expect(auth.authorizeInjectedRequest(request(right!, 'GET', '/api/v1/orgs/org-1'))).toBe(true)
    })
  })

  it('keeps awaited work authoritative until the active run callback finishes', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      await Promise.resolve()
      const nonce = auth.issue('GET', '/api/v1/me')
      await Promise.resolve()

      expect(auth.authorizeInjectedRequest(request(nonce))).toBe(true)
    })
  })

  it('preserves null for invalid method or path inside an active run', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      expect(auth.issue('GET /', '/api/v1/me')).toBeNull()
      expect(auth.issue('GET', '//[invalid')).toBeNull()
    })
  })

  it('consumes a nonce atomically exactly once', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      const nonce = auth.issue('GET', '/api/v1/me')!
      expect(auth.authorizeInjectedRequest(request(nonce))).toBe(true)
      expect(auth.authorizeInjectedRequest(request(nonce))).toBe(false)
    })
  })

  it('binds exact normalized HTTP method and path and burns a mismatched nonce', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      const nonce = auth.issue(' get ', 'api/v1/me?view=full')!
      expect(auth.authorizeInjectedRequest(request(nonce, 'POST', '/api/v1/me?view=full'))).toBe(false)
      expect(auth.authorizeInjectedRequest(request(nonce, 'GET', '/api/v1/me?view=full'))).toBe(false)

      const exact = auth.issue('get', 'api/v1/me?view=full')!
      expect(auth.authorizeInjectedRequest(request(exact, 'GET', '/api/v1/me?view=full'))).toBe(true)
    })
  })

  it('cannot authenticate a copied header outside its async-local context', async () => {
    const auth = new InternalInvocationAuth()
    let copied = ''
    await auth.run(CONTEXT, async () => {
      copied = auth.issue('GET', '/api/v1/me')!
    })

    const req = request(copied)
    expect(auth.authorizeInjectedRequest(req)).toBe(false)
    expect(req.principal).toBeUndefined()
    expect(req.apiKeyOrgId).toBeUndefined()
    expect(req.apiKeyScopes).toBeUndefined()
    expect(req.delegatedInvocation).toBeUndefined()
  })

  it('gives unrelated inherited async work no authority without its own issued nonce', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      await Promise.resolve()
      expect(auth.authorizeInjectedRequest(request())).toBe(false)
    })
  })

  it('does not let a nonce from one run authenticate in an independent parallel run', async () => {
    const auth = new InternalInvocationAuth()
    let leftNonce = ''
    let releaseLeft!: () => void
    const leftReady = new Promise<void>((resolve) => {
      releaseLeft = resolve
    })

    await Promise.all([
      auth.run(CONTEXT, async () => {
        leftNonce = auth.issue('GET', '/api/v1/me')!
        releaseLeft()
        await Promise.resolve()
      }),
      auth.run({ ...CONTEXT, userId: 'user-2' }, async () => {
        await leftReady
        expect(auth.authorizeInjectedRequest(request(leftNonce))).toBe(false)
      })
    ])
  })

  it('sets exactly the delegated principal projection after successful authorization', async () => {
    const auth = new InternalInvocationAuth()

    await auth.run(CONTEXT, async () => {
      const req = request(auth.issue('GET', '/api/v1/me')!)

      expect(auth.authorizeInjectedRequest(req)).toBe(true)
      expect(req.principal).toEqual({ userId: USER_ID })
      expect(req.apiKeyOrgId).toBe(ORG_ID)
      expect(req.apiKeyScopes).toEqual(['mcp:read', 'mcp:write'])
      expect(req.delegatedInvocation).toEqual({
        invocationId: CONTEXT.invocationId,
        grantId: CONTEXT.grantId,
        agentId: CONTEXT.agentId,
        conversationId: CONTEXT.conversationId
      })
      expect(req.apiKeyId).toBeUndefined()
      expect(req.oidcSubject).toBeUndefined()
    })
  })
})

const USER_ID = CONTEXT.userId
const ORG_ID = CONTEXT.orgId
