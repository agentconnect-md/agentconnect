import { describe, expect, it, vi } from 'vitest'
import {
  handleOpenConnectorMessage,
  isOpenConnectorBinding,
  openConnectorBase,
  respondOpenConnector,
  type OpenConnectorContext
} from './open-connector.js'

const HEADERS = (over: Record<string, string> = {}) =>
  Object.entries({ 'x-oomol-connector-alias': 'org--user--prod', 'x-oomol-connector-service': 'gmail', ...over }).map(
    ([name, value]) => ({ name, value })
  )

function stubFetch(
  routes: Record<string, unknown>,
  capture?: { calls: Array<{ url: string; body: unknown; redirect?: RequestInit['redirect'] }> }
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    capture?.calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, redirect: init?.redirect })
    const key = Object.keys(routes).find((k) => url.includes(k))
    const body = key ? routes[key] : { success: false, message: 'not found' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

const ctx = (fetchImpl: typeof fetch): OpenConnectorContext => ({
  base: 'http://oc.example.com',
  service: 'gmail',
  profile: 'org--user--prod',
  fetchImpl
})

describe('binding detection + base url', () => {
  it('isOpenConnectorBinding requires both markers', () => {
    expect(isOpenConnectorBinding(HEADERS())).toBe(true)
    expect(isOpenConnectorBinding([{ name: 'x-oomol-connector-alias', value: 'a' }])).toBe(false)
    expect(isOpenConnectorBinding([{ name: 'authorization', value: 'x' }])).toBe(false)
  })

  it('openConnectorBase normalizes the operator origin (trailing slash / accidental /mcp)', () => {
    expect(openConnectorBase('http://oc.example.com')).toBe('http://oc.example.com')
    expect(openConnectorBase('http://oc.example.com/')).toBe('http://oc.example.com')
    expect(openConnectorBase('http://oc.example.com/mcp')).toBe('http://oc.example.com')
  })
})

describe('handleOpenConnectorMessage', () => {
  it('initialize advertises tools + echoes protocolVersion', async () => {
    const res = await handleOpenConnectorMessage(ctx(stubFetch({})), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    })
    expect(res?.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'open-connector:gmail' }
    })
  })

  it('notifications/initialized yields no response', async () => {
    expect(
      await handleOpenConnectorMessage(ctx(stubFetch({})), { jsonrpc: '2.0', method: 'notifications/initialized' })
    ).toBeNull()
  })

  it('tools/list maps actions for the bound service to MCP tools', async () => {
    const capture = { calls: [] as Array<{ url: string; body: unknown; redirect?: RequestInit['redirect'] }> }
    const fetchImpl = stubFetch(
      {
        '/v1/actions': {
          success: true,
          data: [
            { id: 'gmail.send', name: 'Send', description: 'Send email', inputSchema: { type: 'object' } },
            { id: 'gmail.list', description: 'List', inputSchema: { type: 'object' } }
          ]
        }
      },
      capture
    )
    const res = await handleOpenConnectorMessage(ctx(fetchImpl), { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(capture.calls[0]?.url).toContain('/v1/actions?service=gmail')
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema: object }> }).tools
    expect(tools.map((t) => t.name)).toEqual(['gmail.send', 'gmail.list'])
    expect(tools[0]?.inputSchema).toEqual({ type: 'object' })
  })

  it('tools/call posts to /v1/actions/<id> with the profile and returns the output', async () => {
    const capture = { calls: [] as Array<{ url: string; body: unknown; redirect?: RequestInit['redirect'] }> }
    const fetchImpl = stubFetch({ '/v1/actions/gmail.send': { success: true, data: { id: 'msg_1' } } }, capture)
    const res = await handleOpenConnectorMessage(ctx(fetchImpl), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gmail.send', arguments: { to: 'a@b.c' } }
    })
    expect(capture.calls[0]?.url).toContain('/v1/actions/gmail.send')
    expect(capture.calls[0]?.body).toEqual({ input: { to: 'a@b.c' }, connectionName: 'org--user--prod' })
    // Egress must never follow redirects (SSRF / bearer-leak guard).
    expect(capture.calls[0]?.redirect).toBe('error')
    expect(res?.result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ id: 'msg_1' }) }] })
  })

  it('tools/call surfaces an open-connector failure as an isError tool result', async () => {
    const fetchImpl = stubFetch({ '/v1/actions/gmail.send': { success: false, message: 'auth expired' } })
    const res = await handleOpenConnectorMessage(ctx(fetchImpl), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'gmail.send', arguments: {} }
    })
    expect(res?.result).toEqual({ content: [{ type: 'text', text: 'auth expired' }], isError: true })
  })

  it('unknown method → JSON-RPC method-not-found', async () => {
    const res = await handleOpenConnectorMessage(ctx(stubFetch({})), { jsonrpc: '2.0', id: 5, method: 'bogus' })
    expect(res?.error?.code).toBe(-32601)
  })
})

describe('respondOpenConnector', () => {
  it('answers a notification with 202 and no body', async () => {
    expect(
      await respondOpenConnector(ctx(stubFetch({})), { jsonrpc: '2.0', method: 'notifications/initialized' })
    ).toEqual({ status: 202 })
  })

  it('answers a request with 200 + the response object', async () => {
    const { status, json } = await respondOpenConnector(ctx(stubFetch({})), { jsonrpc: '2.0', id: 9, method: 'ping' })
    expect(status).toBe(200)
    expect(json).toMatchObject({ jsonrpc: '2.0', id: 9, result: {} })
  })
})
