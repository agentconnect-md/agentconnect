import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { buildRelayServer } from '../server.js'
import { registerMcpProxy, registerMemoryPluginProxy } from './proxy.js'
import { McpBindingTable } from './binding-table.js'
import { MemoryConnectionBindingTable } from '../memory/binding-table.js'

const PID = '11111111-1111-4111-8111-111111111111'
const hash = (k: string) => createHash('sha256').update(k).digest('hex')
const silent = { debug() {}, info() {}, warn() {}, error() {} }

// A fake upstream MCP server: records the last request it saw, echoes a fixed body.
function fakeUpstream(): Promise<{
  url: string
  last: () => { headers: IncomingMessage['headers']; body: string }
  close: () => Promise<void>
}> {
  let captured = { headers: {} as IncomingMessage['headers'], body: '' }
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      captured = { headers: req.headers, body }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://${req.headers.host}/redirect-target` })
        res.end()
        return
      }
      // The RFC 9728 challenge an OAuth-protected MCP server answers an unauthorized call with.
      if (req.url === '/unauthorized' || req.url === '/forbidden') {
        res.writeHead(req.url === '/unauthorized' ? 401 : 403, {
          'www-authenticate': `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource"`,
          'content-type': 'application/json'
        })
        res.end(JSON.stringify({ error: 'invalid_token', upstream_hint: 'secret-ish' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echoed: body }))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        last: () => captured,
        close: () => new Promise((r) => srv.close(() => r()))
      })
    })
  })
}

async function startRelay(allowlist: string[]) {
  const bindings = new McpBindingTable()
  const app = buildRelayServer({ isReady: () => true, relayId: () => 'r1' }, { logger: false })
  registerMcpProxy(app, { bindings, allowlist: new Set(allowlist), log: silent })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { bindings, base: `http://127.0.0.1:${port}`, close: () => app.close() }
}

async function startPurposeSeparatedRelay(allowlist: string[]) {
  const mcp = new McpBindingTable()
  const memory = new MemoryConnectionBindingTable()
  const app = buildRelayServer({ isReady: () => true, relayId: () => 'r1' }, { logger: false })
  registerMcpProxy(app, { bindings: mcp, allowlist: new Set(allowlist), log: silent })
  registerMemoryPluginProxy(app, { bindings: memory, allowlist: new Set(allowlist), log: silent })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { mcp, memory, base: `http://127.0.0.1:${port}`, close: () => app.close() }
}

describe('registerMcpProxy — MCP reverse proxy route', () => {
  let upstream: Awaited<ReturnType<typeof fakeUpstream>>
  beforeAll(async () => {
    upstream = await fakeUpstream()
  })
  afterAll(async () => {
    await upstream.close()
  })

  it('401s without a bearer, and with an invalid grant key', async () => {
    // localhost upstream requires the allowlist bypass (SSRF guard blocks loopback otherwise).
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: upstream.url,
      headers: [{ name: 'x-upstream-auth', value: 'real-secret' }],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      expect((await fetch(`${relay.base}/mcp/${PID}`, { method: 'POST', body: '{}' })).status).toBe(401)
      expect(
        (
          await fetch(`${relay.base}/mcp/${PID}`, {
            method: 'POST',
            headers: { authorization: 'Bearer nope' },
            body: '{}'
          })
        ).status
      ).toBe(401)
    } finally {
      await relay.close()
    }
  })

  it('forwards the body, injects the upstream headers, and does NOT leak the agent grant key upstream', async () => {
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: upstream.url,
      headers: [{ name: 'x-upstream-auth', value: 'real-secret' }],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
      })
      expect(res.status).toBe(200)
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true })
      const seen = upstream.last()
      expect(seen.body).toContain('"method":"ping"') // body forwarded
      expect(seen.headers['x-upstream-auth']).toBe('real-secret') // real credential injected
      expect(seen.headers.authorization).toBeUndefined() // agent grant key NOT forwarded
    } finally {
      await relay.close()
    }
  })

  it('blocks a private/loopback upstream when the host is not allowlisted (SSRF guard wired into the path)', async () => {
    const relay = await startRelay([]) // no allowlist ⇒ loopback is blocked
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: upstream.url, // 127.0.0.1 — reachable but private
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
      expect(await res.json()).toEqual({ error: 'blocked upstream address' })
    } finally {
      await relay.close()
    }
  })

  it('reports a hostname the guarded lookup blocks as a misconfiguration, not an outage', async () => {
    const relay = await startRelay([]) // localhost resolves to loopback, which the guarded lookup refuses
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: upstream.url.replace('127.0.0.1', 'localhost'),
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
      expect(await res.json()).toEqual({ error: 'blocked upstream address' })
    } finally {
      await relay.close()
    }
  })

  it('answers an unreachable upstream with a retryable 503', async () => {
    const closed = await fakeUpstream()
    await closed.close() // nothing listens on this port any more
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: closed.url,
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'upstream unreachable' })
    } finally {
      await relay.close()
    }
  })

  it('blocks an IPv6-literal loopback upstream (http://[::1]) — brackets must not defeat the literal check', async () => {
    const relay = await startRelay([]) // no allowlist
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: 'http://[::1]:9/mcp', // bracketed IPv6 loopback — rejected up front, never dialed
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
    } finally {
      await relay.close()
    }
  })

  it('rejects upstream redirects so the MCP client cannot follow around the SSRF gate', async () => {
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: `${upstream.url}/redirect`,
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
      expect(await res.json()).toEqual({ error: 'upstream redirect rejected' })
    } finally {
      await relay.close()
    }
  })

  it.each([
    ['/unauthorized', 401],
    ['/forbidden', 403]
  ])('contains an upstream %s (%i) so its auth challenge never reaches the MCP client', async (path) => {
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: `${upstream.url}${path}`,
      headers: [{ name: 'authorization', value: 'Bearer stale-upstream-token' }],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
      expect(res.headers.get('www-authenticate')).toBeNull()
      expect(await res.json()).toEqual({
        error: "upstream rejected this provider's configured credential; an admin must update it"
      })
    } finally {
      await relay.close()
    }
  })

  it('keeps a grant-key 401 distinguishable from a contained upstream rejection', async () => {
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: `${upstream.url}/unauthorized`,
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-grant' },
        body: '{}'
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unknown provider or invalid grant key' })
    } finally {
      await relay.close()
    }
  })

  it('rejects URL userinfo at the egress boundary instead of creating implicit upstream auth', async () => {
    const relay = await startRelay(['127.0.0.1'])
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: upstream.url.replace('http://', 'http://legacy-user:legacy-secret@'),
      headers: [],
      grantKeyHashes: [hash('good-grant')]
    })
    try {
      const res = await fetch(`${relay.base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer good-grant' },
        body: '{}'
      })
      expect(res.status).toBe(424)
      expect(await res.json()).toEqual({ error: 'upstream url credentials rejected' })
    } finally {
      await relay.close()
    }
  })

  it('keeps memory grants/routes isolated from model-facing MCP grants while sharing the hardened proxy', async () => {
    const relay = await startPurposeSeparatedRelay(['127.0.0.1'])
    relay.mcp.assign({
      providerId: PID,
      upstreamUrl: upstream.url,
      headers: [],
      grantKeyHashes: [hash('mcp-grant')]
    })
    relay.memory.assign({
      connectionId: PID,
      revision: 1,
      upstreamUrl: upstream.url,
      headers: [{ name: 'x-memory-auth', value: 'memory-secret' }],
      grantKeyHashes: [hash('memory-grant')]
    })
    try {
      expect(
        (
          await fetch(`${relay.base}/memory/${PID}`, {
            method: 'POST',
            headers: { authorization: 'Bearer mcp-grant' },
            body: '{}'
          })
        ).status
      ).toBe(401)
      const response = await fetch(`${relay.base}/memory/${PID}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer memory-grant',
          'content-type': 'application/json',
          'X-Memory-Auth': 'client-override-must-be-dropped'
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
      })
      expect(response.status).toBe(200)
      expect(upstream.last().headers['x-memory-auth']).toBe('memory-secret')
      expect(upstream.last().headers.authorization).toBeUndefined()
      expect(
        (
          await fetch(`${relay.base}/mcp/${PID}`, {
            method: 'POST',
            headers: { authorization: 'Bearer memory-grant' },
            body: '{}'
          })
        ).status
      ).toBe(401)
    } finally {
      await relay.close()
    }
  })
})

// A fake MCP upstream: lists three tools as JSON, SSE or plain text by path, and records every request it sees.
function fakeMcpUpstream(): Promise<{
  url: string
  seen: Array<{ path: string; headers: IncomingMessage['headers']; body: string }>
  close: () => Promise<void>
}> {
  const seen: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = []
  const tools = [{ name: 'read_note' }, { name: 'write_note' }, { name: 'delete_note' }]
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body })
      const message = JSON.parse(body || '{}') as { id?: number; method?: string }
      const answer =
        message.method === 'tools/list'
          ? { jsonrpc: '2.0', id: message.id, result: { tools } }
          : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\n`)
        res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`)
        return
      }
      if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(JSON.stringify(answer))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => srv.close(() => r())) })
    })
  })
}

describe('registerMcpProxy — restricted agent grants (mcp-tool-permissions.md §6.2)', () => {
  let upstream: Awaited<ReturnType<typeof fakeMcpUpstream>>
  let relay: Awaited<ReturnType<typeof startRelay>>
  beforeAll(async () => {
    upstream = await fakeMcpUpstream()
    relay = await startRelay(['127.0.0.1'])
  })
  afterAll(async () => {
    await relay.close()
    await upstream.close()
  })

  const bind = (path: string) =>
    relay.bindings.assign({
      providerId: PID,
      upstreamUrl: `${upstream.url}${path}`,
      headers: [],
      grantKeyHashes: [hash('shared')],
      toolPolicies: [
        { allow: ['read_note'], approval: ['write_note'], ask: [] },
        { allow: [], approval: [], ask: ['delete_note'] }
      ],
      restrictedGrants: [
        { grantKeyHash: hash('agent'), policy: 0 },
        { grantKeyHash: hash('asker'), policy: 1 }
      ]
    })
  const post = (key: string, body: string, extra: Record<string, string> = {}) =>
    fetch(`${relay.base}/mcp/${PID}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra },
      body
    })
  const listTools = async (res: Response) => {
    const text = await res.text()
    const data = text.includes('data:')
      ? text
          .split('\n\n')
          .map((event) =>
            event
              .split('\n')
              .find((line) => line.startsWith('data:'))
              ?.slice(5)
          )
          .filter((line): line is string => line !== undefined)
          .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } })
          .find((message) => message.id === 1)
      : (JSON.parse(text) as { id?: number; result?: { tools?: Array<{ name: string }> }; error?: unknown })
    return data
  }

  it('refuses a blocked call, and an unapproved gated one, without reaching the upstream', async () => {
    bind('/json')
    const before = upstream.seen.length
    const refusals = [
      ['agent', 'delete_note', {}, 'The tool "delete_note" is blocked for this agent.'],
      ['agent', 'write_note', {}, 'The tool "write_note" requires approval, and this call was not approved.'],
      ['agent', 'write_note', { 'x-ac-tool-approval': 'nobody' }, 'requires approval'],
      ['asker', 'delete_note', { 'x-ac-tool-approval': 'runtime-review' }, 'requires approval']
    ] as const
    for (const [key, name, extra, text] of refusals) {
      const call = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name } })
      const res = await post(key, call, extra)
      expect(res.status).toBe(200)
      const answer = (await res.json()) as { id: number; result: { isError: boolean; content: [{ text: string }] } }
      expect(answer).toMatchObject({ id: 5, result: { isError: true } })
      expect(answer.result.content[0].text).toContain(text)
    }
    expect(upstream.seen.length).toBe(before)
  })

  it('forwards an approved gated call when the approval source satisfies its decision, without the header', async () => {
    bind('/json')
    const approved = [
      ['agent', 'write_note', 'runtime-review'],
      ['agent', 'write_note', 'person'],
      ['asker', 'delete_note', 'person']
    ] as const
    for (const [key, name, source] of approved) {
      const call = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name } })
      const res = await post(key, call, { 'x-ac-tool-approval': source })
      expect(await res.json()).toMatchObject({ id: 8, result: { content: [{ text: 'ok' }] } })
      const last = upstream.seen.at(-1)!
      expect(JSON.parse(last.body)).toMatchObject({ params: { name } })
      expect(last.headers['x-ac-tool-approval']).toBeUndefined()
    }
  })

  it('answers a batch with an approval-gated member itself, even with an approval header', async () => {
    bind('/json')
    const before = upstream.seen.length
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_note' } }
    ])
    const answers = (await (await post('agent', batch, { 'x-ac-tool-approval': 'person' })).json()) as unknown[]
    expect(answers).toMatchObject([
      { id: 1, error: {} },
      { id: 2, result: { isError: true } }
    ])
    expect(upstream.seen.length).toBe(before)
  })

  it('forwards an allowed call as the judged message, without the approval header', async () => {
    bind('/json')
    const raw = '{ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "read_note" } }'
    const res = await post('agent', raw, { 'x-ac-tool-approval': 'person' })
    expect(res.status).toBe(200)
    const last = upstream.seen.at(-1)!
    expect(last.body).toBe(JSON.stringify(JSON.parse(raw)))
    expect(last.headers['x-ac-tool-approval']).toBeUndefined()
  })

  it('filters tools/list over JSON and over SSE', async () => {
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    for (const path of ['/json', '/sse']) {
      bind(path)
      const message = await listTools(await post('agent', list))
      expect(message?.result?.tools?.map((tool) => tool.name)).toEqual(['read_note', 'write_note'])
    }
  })

  it('answers with an error when a tools/list response is neither JSON nor SSE', async () => {
    bind('/text')
    const res = await post('agent', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const message = await listTools(res)
    expect(message).toMatchObject({ id: 1, error: {} })
  })

  it('keeps the shared grant on the same provider byte-transparent', async () => {
    bind('/json')
    const raw = '{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }'
    const message = await listTools(await post('shared', raw))
    expect(message?.result?.tools).toHaveLength(3)
    expect(upstream.seen.at(-1)!.body).toBe(raw)
    const call = await post(
      'shared',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_note' } })
    )
    expect(await call.json()).toMatchObject({ result: { content: [{ text: 'ok' }] } })
  })
})

describe('registerMcpProxy — restricted grants on open_connector providers', () => {
  it('applies the same checks through the adapter, and lists only the tools it does not block', async () => {
    const oc = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      const actions = [{ id: 'read_mail' }, { id: 'send_mail' }, { id: 'delete_mail' }]
      const data = req.url?.startsWith('/v1/actions?') ? actions : { sent: true }
      res.end(JSON.stringify({ success: true, data }))
    })
    await new Promise<void>((r) => oc.listen(0, '127.0.0.1', () => r()))
    const { port } = oc.address() as AddressInfo
    const bindings = new McpBindingTable()
    const app = buildRelayServer({ isReady: () => true, relayId: () => 'r1' }, { logger: false })
    registerMcpProxy(app, { bindings, allowlist: new Set(), log: silent, openConnectorUrl: `http://127.0.0.1:${port}` })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    bindings.assign({
      providerId: PID,
      upstreamUrl: 'https://oc.example.test/mcp',
      headers: [
        { name: 'x-oomol-connector-service', value: 'gmail' },
        { name: 'x-oomol-connector-alias', value: 'profile' }
      ],
      grantKeyHashes: [hash('shared')],
      toolPolicies: [{ allow: ['read_mail'], approval: [], ask: ['send_mail'] }],
      restrictedGrants: [{ grantKeyHash: hash('agent'), policy: 0 }]
    })
    const post = (message: unknown, extra: Record<string, string> = {}) =>
      fetch(`${base}/mcp/${PID}`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent', 'content-type': 'application/json', ...extra },
        body: JSON.stringify(message)
      }).then((res) => res.json() as Promise<{ result?: { tools?: Array<{ name: string }>; isError?: boolean } }>)
    try {
      const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(list.result?.tools?.map((tool) => tool.name)).toEqual(['read_mail', 'send_mail'])
      const blocked = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_mail' } })
      expect(blocked.result?.isError).toBe(true)
      const send = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_mail', arguments: {} } }
      expect((await post(send)).result?.isError).toBe(true)
      expect((await post(send, { 'x-ac-tool-approval': 'runtime-review' })).result?.isError).toBe(true)
      expect((await post(send, { 'x-ac-tool-approval': 'person' })).result?.isError).toBeFalsy()
    } finally {
      await app.close()
      await new Promise((r) => oc.close(() => r(undefined)))
    }
  })
})
