import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { InvocationContext } from './invocation-authenticator.js'

export const INTERNAL_INVOCATION_AUTH_HEADER = 'x-agentconnect-internal-invocation'

interface PendingNonce {
  method: string
  path: string
}

export interface InvocationContextState {
  context: InvocationContext
  pending: Map<string, PendingNonce>
  active: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    delegatedInvocation?: {
      invocationId: string
      delegationId: string
      agentId: string
      conversationId: string
    }
  }
}

export class InternalInvocationAuth {
  private readonly storage = new AsyncLocalStorage<InvocationContextState>()

  async run<T>(context: InvocationContext, fn: () => Promise<T>): Promise<T> {
    const state: InvocationContextState = { context, pending: new Map(), active: true }
    return this.storage.run(state, async () => {
      try {
        return await fn()
      } finally {
        state.active = false
        state.pending.clear()
      }
    })
  }

  issue(method: string, path: string): string {
    const state = this.storage.getStore()
    if (!state?.active) throw new Error('Internal invocation nonce issuance requires an active invocation context')
    const normalizedMethod = normalizeMethod(method)
    const normalizedPath = normalizePath(path)
    if (!normalizedMethod || !normalizedPath) throw new Error('Invalid internal invocation method or path')
    const nonce = randomBytes(32).toString('base64url')
    state.pending.set(nonce, { method: normalizedMethod, path: normalizedPath })
    return nonce
  }

  authorizeInjectedRequest(req: FastifyRequest): boolean {
    const rawHeader = req.headers[INTERNAL_INVOCATION_AUTH_HEADER]
    if (typeof rawHeader !== 'string' || rawHeader.length === 0) return false
    const state = this.storage.getStore()
    if (!state?.active) return false

    // Delete before comparing or mutating the request. A guessed/misbound use
    // burns the nonce, and two parallel consumers cannot both observe it.
    const expected = state.pending.get(rawHeader)
    if (!expected) return false
    state.pending.delete(rawHeader)
    const method = normalizeMethod(req.method)
    const path = normalizePath(req.url)
    if (!method || !path || method !== expected.method || path !== expected.path) return false

    const { context } = state
    req.principal = { userId: context.userId }
    req.apiKeyOrgId = context.orgId
    req.apiKeyScopes = ['mcp:read', 'mcp:write']
    req.delegatedInvocation = {
      invocationId: context.invocationId,
      delegationId: context.delegationId,
      agentId: context.agentId,
      conversationId: context.conversationId
    }
    return true
  }
}

function normalizeMethod(method: string): string | null {
  const normalized = method.trim().toUpperCase()
  return /^[A-Z]+$/.test(normalized) ? normalized : null
}

function normalizePath(path: string): string | null {
  try {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, 'http://internal.invalid')
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}
