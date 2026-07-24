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
      expect(res.status).toBe(502) // guarded lookup errors the connection
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
      expect(res.status).toBe(502)
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
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'upstream redirect rejected' })
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
      expect(res.status).toBe(502)
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
