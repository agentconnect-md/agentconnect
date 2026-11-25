import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { catalogTool, fetchMcpCatalog } from './catalog.js'
import { OPEN_CONNECTOR_ALIAS_HEADER, OPEN_CONNECTOR_SERVICE_HEADER } from './open-connector.js'

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

// A fake MCP server: a session per initialize, two pages of tools, and a few misbehaving paths.
function fakeServer(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const pages: Record<string, unknown[]> = {
    '': [
      {
        name: 'read_note',
        title: 'Read a note',
        description: 'Reads.',
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      { name: 'draft_message', _meta: { ui: { resourceUri: 'ui://draft' } }, annotations: { readOnlyHint: false } }
    ],
    next: [{ name: 'plain_write' }, { title: 'no name' }]
  }
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>
      const path = req.url ?? ''
      seen.push({ method: req.method ?? '', path, headers: req.headers, body })
      if (path === '/rejects') {
        res.writeHead(401, { 'www-authenticate': 'Bearer' })
        res.end()
        return
      }
      if (req.method === 'DELETE') {
        res.writeHead(200)
        res.end()
        return
      }
      if (body.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      let result: unknown
      if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
      else if (path === '/endless') result = { tools: [{ name: 'x' }], nextCursor: 'more' }
      else {
        const cursor = ((body.params as { cursor?: string } | undefined)?.cursor ?? '') as string
        result = { tools: pages[cursor], ...(cursor === '' ? { nextCursor: 'next' } : {}) }
      }
      const answer = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
      const headers: Record<string, string> = body.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {}
      if (path === '/sse') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' })
        res.end(`event: message\ndata: ${answer}\n\n`)
        return
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' })
      res.end(answer)
    })
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => srv.close(() => r())) })
    })
  })
}

describe('fetchMcpCatalog', () => {
  let server: Awaited<ReturnType<typeof fakeServer>>
  const allowlist = new Set(['127.0.0.1'])
  beforeAll(async () => {
    server = await fakeServer()
  })
  afterAll(() => server.close())

  it('pages through tools/list in one session with the binding credential, then ends the session', async () => {
    server.seen.length = 0
    const credential = [{ name: 'Authorization', value: 'Bearer upstream-secret' }]
    const result = await fetchMcpCatalog({ upstreamUrl: `${server.url}/json`, headers: credential }, { allowlist })
    expect(result.tools?.map((tool) => tool.name)).toEqual(['read_note', 'draft_message', 'plain_write'])
    expect(result.tools?.[0]).toEqual({
      name: 'read_note',
      title: 'Read a note',
      description: 'Reads.',
      readOnlyHint: true,
      openWorldHint: false,
      interactive: false
    })
    expect(result.tools?.[1]?.interactive).toBe(true)
    expect(server.seen.map((s) => (s.method === 'DELETE' ? 'DELETE' : s.body.method))).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
      'DELETE'
    ])
    expect(server.seen.every((s) => s.headers.authorization === 'Bearer upstream-secret')).toBe(true)
    expect(server.seen.slice(1).every((s) => s.headers['mcp-session-id'] === 'session-1')).toBe(true)
  })

  it('reads replies streamed as SSE', async () => {
    const result = await fetchMcpCatalog({ upstreamUrl: `${server.url}/sse`, headers: [] }, { allowlist })
    expect(result.tools).toHaveLength(3)
  })

  it('reports closed failure codes, never the upstream detail', async () => {
    expect(await fetchMcpCatalog(null, { allowlist })).toEqual({ failure: 'unknown_provider' })
    expect(await fetchMcpCatalog({ upstreamUrl: `${server.url}/rejects`, headers: [] }, { allowlist })).toEqual({
      failure: 'upstream_rejected'
    })
    expect(await fetchMcpCatalog({ upstreamUrl: `${server.url}/endless`, headers: [] }, { allowlist })).toEqual({
      failure: 'too_large'
    })
    expect(await fetchMcpCatalog({ upstreamUrl: 'ftp://example.test', headers: [] }, { allowlist })).toEqual({
      failure: 'misconfigured'
    })
  })

  it('applies the proxy egress guard to a private upstream that is not allowlisted', async () => {
    expect(await fetchMcpCatalog({ upstreamUrl: `${server.url}/json`, headers: [] }, { allowlist: new Set() })).toEqual(
      {
        failure: 'blocked_address'
      }
    )
  })

  it('lists an open_connector provider through its adapter', async () => {
    const oc = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, data: [{ id: 'send_mail', description: 'Sends mail.' }] }))
    })
    await new Promise<void>((r) => oc.listen(0, '127.0.0.1', () => r()))
    const { port } = oc.address() as AddressInfo
    const headers = [
      { name: OPEN_CONNECTOR_SERVICE_HEADER, value: 'gmail' },
      { name: OPEN_CONNECTOR_ALIAS_HEADER, value: 'profile' }
    ]
    const result = await fetchMcpCatalog(
      { upstreamUrl: 'https://unused.example.test/mcp', headers },
      { allowlist, openConnectorUrl: `http://127.0.0.1:${port}` }
    )
    await new Promise((r) => oc.close(() => r(undefined)))
    expect(result).toEqual({ tools: [{ name: 'send_mail', description: 'Sends mail.', interactive: false }] })
  })
})

describe('catalogTool', () => {
  it('takes the annotations title when the tool has none, and skips a tool without a name', () => {
    expect(catalogTool({ name: 't', annotations: { title: 'From annotations' } })?.title).toBe('From annotations')
    expect(catalogTool({ title: 'x' })).toBeUndefined()
    expect(catalogTool({ name: 'legacy', _meta: { 'ui/resourceUri': 'ui://x' } })?.interactive).toBe(true)
  })
})
