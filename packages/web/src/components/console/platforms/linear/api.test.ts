// The bindings' wire shape. The CP routes are org-scoped and their DTOs are fixed
// (control-plane/src/platforms/linear/routes.ts), so a drifted path or body here is
// a 404/400 no type checks — the funnel start doubles as the console's ONLY signal
// that the deployment registered a Linear app, and a wrong path fakes that answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setApiOrgId } from '@/lib/api'
import { linearApi } from './api'

type Call = { url: string; method: string; body: unknown }

let calls: Call[]

function stubFetch(status = 200, payload: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      })
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    })
  )
}

const pathOf = (call: Call) => new URL(call.url, 'http://cp.example.test').pathname

beforeEach(() => {
  calls = []
  setApiOrgId('org-7')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setApiOrgId(null)
})

describe('linear api bindings', () => {
  it('starts a connect against the org funnel, carrying the chosen default agent', async () => {
    stubFetch(201, { id: 'connect-1', connectUrl: 'https://linear.app/oauth/authorize?state=connect-1' })
    const started = await linearApi.startConnect('agent-a')

    expect(pathOf(calls[0]!)).toBe('/api/v1/orgs/org-7/integrations/linear/connect')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ agentId: 'agent-a' })
    expect(started).toEqual({ id: 'connect-1', connectUrl: 'https://linear.app/oauth/authorize?state=connect-1' })
  })

  it('polls the funnel row by its id', async () => {
    stubFetch(200, { id: 'connect-1', status: 'completed', failureReason: null, botId: 'bot-9' })
    const row = await linearApi.getConnect('connect-1')

    expect(pathOf(calls[0]!)).toBe('/api/v1/orgs/org-7/integrations/linear/connect/connect-1')
    expect(calls[0]!.method).toBe('GET')
    expect(row.botId).toBe('bot-9')
  })

  it('reconnects against the bot, not the org — the nonce is bound to that workspace', async () => {
    stubFetch(201, { id: 'connect-2', connectUrl: 'https://linear.app/oauth/authorize?state=connect-2' })
    await linearApi.reconnect('bot-9')

    expect(pathOf(calls[0]!)).toBe('/api/v1/orgs/org-7/bots/bot-9/linear/reconnect')
    expect(calls[0]!.method).toBe('POST')
  })

  it('moves the default agent through the generic bot patch', async () => {
    stubFetch(200, { id: 'bot-9' })
    await linearApi.setDefaultAgent('bot-9', 'agent-b')
    expect(pathOf(calls[0]!)).toBe('/api/v1/orgs/org-7/bots/bot-9')
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.body).toEqual({ preferredAgentId: 'agent-b' })

    // Null is a real value here — it restores the earliest-member derivation.
    calls = []
    await linearApi.setDefaultAgent('bot-9', null)
    expect(calls[0]!.body).toEqual({ preferredAgentId: null })
  })

  it('surfaces the funnel’s 404 as an ApiError the pane can recognize', async () => {
    // The self-disable signal: without the deployment app, both routes 404.
    stubFetch(404, { error: 'Not Found', statusCode: 404, message: 'not found' })
    await expect(linearApi.startConnect('agent-a')).rejects.toBeInstanceOf(ApiError)
    await expect(linearApi.startConnect('agent-a')).rejects.toMatchObject({ status: 404 })
  })
})
