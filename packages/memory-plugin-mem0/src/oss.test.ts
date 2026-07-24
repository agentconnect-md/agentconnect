import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryPluginClient,
  MemoryPluginConflictError,
  memoryPluginManifestDigest
} from '../../daemon/src/memory-plugin/client.js'
import { Mem0OssClient } from './oss.js'
import { MEM0_OSS_MANIFEST, startMem0OssServer } from './oss-server.js'

interface SeenRequest {
  method: string
  path: string
  query: Record<string, string>
  apiKey?: string
  authorization?: string
  body?: any
}

const closers: Array<() => Promise<void>> = []
const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json)
}

async function startOssUpstream(options: { foreign?: boolean; redirect?: boolean } = {}) {
  const records = new Map<string, Record<string, unknown>>([
    [
      'memory-1',
      {
        id: 'memory-1',
        memory: 'Deploy in sea.',
        agent_id: options.foreign ? 'ac:agent:other' : 'ac:agent:bot-a',
        hash: 'hash-1',
        metadata: { source: 'turn' },
        created_at: '2026-07-16T00:00:00Z',
        updated_at: '2026-07-16T00:01:00Z'
      }
    ],
    [
      'memory-2',
      {
        id: 'memory-2',
        memory: 'Use pnpm.',
        agent_id: 'ac:agent:bot-a',
        hash: 'hash-2',
        created_at: '2026-07-16T00:02:00Z',
        updated_at: '2026-07-16T00:02:00Z'
      }
    ]
  ])
  const requests: SeenRequest[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const seen: SeenRequest = {
      method: req.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      body: req.method === 'POST' ? await readJson(req) : undefined
    }
    requests.push(seen)
    if (options.redirect) {
      res.writeHead(307, { location: '/unreviewed-target' }).end()
      return
    }
    if (seen.path === '/search' && seen.method === 'POST') {
      return send(res, 200, { results: [records.get('memory-1')] })
    }
    if (seen.path === '/memories' && seen.method === 'GET') {
      const topK = Number(seen.query.top_k ?? 100)
      return send(res, 200, { results: [...records.values()].slice(0, topK) })
    }
    if (seen.path === '/memories' && seen.method === 'POST') {
      if (seen.body?.infer === false) {
        const id = 'memory-created'
        records.set(id, {
          id,
          memory: seen.body.messages[0].content,
          agent_id: seen.body.agent_id,
          hash: 'hash-created',
          metadata: seen.body.metadata,
          created_at: '2026-07-16T00:03:00Z',
          updated_at: '2026-07-16T00:03:00Z'
        })
        return send(res, 200, { results: [{ id, memory: seen.body.messages[0].content, event: 'ADD' }] })
      }
      return send(res, 200, { results: [{ id: 'capture-result', event: 'ADD' }] })
    }
    const history = seen.path.match(/^\/memories\/([^/]+)\/history$/)
    if (history && seen.method === 'GET') {
      return send(res, 200, [
        {
          id: 'history-1',
          memory_id: decodeURIComponent(history[1]!),
          new_memory: 'Deploy in sea.',
          event: 'ADD',
          created_at: '2026-07-16T00:00:00Z',
          updated_at: '2026-07-16T00:01:00Z',
          metadata: { source: 'turn' }
        }
      ])
    }
    const memory = seen.path.match(/^\/memories\/([^/]+)$/)
    if (memory) {
      const id = decodeURIComponent(memory[1]!)
      const record = records.get(id)
      if (!record) return send(res, 404, { detail: 'not found' })
      if (seen.method === 'DELETE') {
        records.delete(id)
        return send(res, 200, { message: 'Memory deleted successfully' })
      }
      if (seen.method === 'GET') return send(res, 200, record)
    }
    return send(res, 404, { detail: 'not found' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OSS fixture failed to bind')
  closers.push(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  )
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

const context = {
  requestId: 'request-oss-1',
  connection: { id: '22222222-2222-4222-8222-222222222222', config: {} },
  scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' }
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('Mem0 OSS plugin contract', () => {
  it('conforms over Streamable HTTP with the separate OSS paths, auth, and synchronous semantics', async () => {
    const upstream = await startOssUpstream()
    const plugin = await startMem0OssServer({ host: '127.0.0.1', port: 0, baseUrl: upstream.url })
    closers.push(() => plugin.close())
    const client = await MemoryPluginClient.connect({
      url: plugin.url,
      headers: [{ name: 'X-Mem0-Api-Key', value: 'oss-secret' }],
      expectedPluginId: 'ai.mem0.memory.oss',
      expectedManifestDigest: memoryPluginManifestDigest(MEM0_OSS_MANIFEST)
    })

    expect(client.hasTool('agentconnect_memory_update')).toBe(false)
    expect(client.hasTool('agentconnect_memory_operation_status')).toBe(false)
    await expect(client.recall({ context, query: 'where?', topK: 5, maxBytes: 8_192 })).resolves.toEqual({
      records: [
        expect.objectContaining({
          id: 'memory-1',
          text: 'Deploy in sea.',
          version: 'hash-1',
          scope: context.scope,
          provenance: { pluginId: 'ai.mem0.memory.oss', backendId: 'memory-1' }
        })
      ]
    })
    await expect(
      client.capture({
        context,
        operationId: 'capture-operation',
        turn: { turnId: 'turn-1', sessionId: 'session-1', input: 'remember', output: 'done' }
      })
    ).resolves.toEqual({ state: 'completed' })
    await expect(client.list({ context, limit: 1 })).resolves.toEqual({
      records: [expect.objectContaining({ id: 'memory-1', scope: context.scope })],
      nextCursor: '1'
    })
    await expect(client.get({ context, id: 'memory-1' })).resolves.toEqual({
      record: expect.objectContaining({ id: 'memory-1', version: 'hash-1', scope: context.scope })
    })
    await expect(
      client.create({
        context,
        operationId: 'create-operation',
        text: 'Keep this exact sentence.',
        metadata: { ui: true }
      })
    ).resolves.toEqual({
      record: expect.objectContaining({
        id: 'memory-created',
        text: 'Keep this exact sentence.',
        version: 'hash-created',
        scope: context.scope
      })
    })
    await expect(client.history({ context, id: 'memory-1', limit: 1 })).resolves.toEqual({
      events: [expect.objectContaining({ id: 'history-1', event: 'create', at: '2026-07-16T00:01:00.000Z' })]
    })
    await expect(
      client.delete({ context, operationId: 'delete-stale', id: 'memory-1', version: 'hash-other' })
    ).rejects.toBeInstanceOf(MemoryPluginConflictError)
    await expect(
      client.delete({ context, operationId: 'delete-current', id: 'memory-1', version: 'hash-1' })
    ).resolves.toEqual({ deleted: true })

    expect(upstream.requests.every((request) => request.apiKey === 'oss-secret')).toBe(true)
    expect(upstream.requests.every((request) => request.authorization === undefined)).toBe(true)
    expect(upstream.requests.find((request) => request.path === '/search')?.body).toEqual({
      query: 'where?',
      filters: { agent_id: 'ac:agent:bot-a' },
      top_k: 5
    })
    const capture = upstream.requests.find((request) => request.path === '/memories' && request.body?.infer === true)
    expect(capture?.body).toMatchObject({
      agent_id: 'ac:agent:bot-a',
      messages: [
        { role: 'user', content: 'remember' },
        { role: 'assistant', content: 'done' }
      ],
      metadata: {
        ac_turn_id: 'turn-1',
        ac_session_id: 'session-1',
        ac_connection_id: context.connection.id
      }
    })
    expect(upstream.requests.find((request) => request.body?.infer === false)?.body).toMatchObject({
      messages: [{ role: 'user', content: 'Keep this exact sentence.' }],
      agent_id: 'ac:agent:bot-a',
      infer: false,
      metadata: { ui: true, ac_operation_id: 'create-operation', ac_connection_id: context.connection.id }
    })
    await client.close()
  })

  it('runs the first-party OSS wrapper over stdio without writing non-MCP output to stdout', async () => {
    const upstream = await startOssUpstream()
    const client = await MemoryPluginClient.connect({
      transport: 'stdio',
      command: process.execPath,
      // This child executes source through tsx, so workspace dependencies must
      // also resolve their source exports. Without the development condition it
      // races the parallel root build for protocol/dist on a clean checkout.
      args: ['--conditions=development', '--import', 'tsx', cliPath],
      env: {
        MEM0_DIALECT: 'oss',
        MCP_TRANSPORT: 'stdio',
        MEM0_OSS_BASE_URL: upstream.url,
        MEM0_API_KEY: 'oss-secret'
      },
      expectedPluginId: 'ai.mem0.memory.oss',
      connectTimeoutMs: 3_000
    })
    await expect(client.recall({ context, query: 'stdio?', topK: 1, maxBytes: 8_192 })).resolves.toEqual({
      records: [expect.objectContaining({ id: 'memory-1', scope: context.scope })]
    })
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', path: '/search', apiKey: 'oss-secret' })
    await client.close()
  })

  it('scope-checks ID-only routes before delete and never follows credential-bearing redirects', async () => {
    const foreign = await startOssUpstream({ foreign: true })
    const foreignClient = new Mem0OssClient({ baseUrl: foreign.url })
    await expect(
      foreignClient.delete({ context, operationId: 'foreign', id: 'memory-1', version: 'hash-1' }, 'secret')
    ).rejects.toThrow(/outside the trusted scope/)
    expect(foreign.requests.map((request) => request.method)).toEqual(['GET'])

    const redirected = await startOssUpstream({ redirect: true })
    const redirectClient = new Mem0OssClient({ baseUrl: redirected.url })
    await expect(
      redirectClient.capture(
        {
          context,
          operationId: 'redirected',
          turn: { turnId: 'turn-redirect', input: 'private input', output: 'private output' }
        },
        'secret'
      )
    ).resolves.toEqual({ state: 'ambiguous' })
    expect(redirected.requests.map((request) => request.path)).toEqual(['/memories'])
  })

  it('fails capture deterministically when local preflight rejects the request before fetch', async () => {
    const upstream = vi.fn<typeof fetch>()
    const client = new Mem0OssClient({ fetch: upstream })
    await expect(
      client.capture(
        {
          context,
          operationId: 'oversized',
          turn: { turnId: 'turn-oversized', input: 'x'.repeat(300 * 1024), output: 'not sent' }
        },
        'secret'
      )
    ).resolves.toEqual({ state: 'failed' })
    await expect(
      client.capture(
        {
          context,
          operationId: 'missing-credential',
          turn: { turnId: 'turn-no-key', input: 'not sent', output: 'not sent' }
        },
        '   '
      )
    ).resolves.toEqual({ state: 'failed' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('accepts null metadata across list, get, recall, and history without failing the response', async () => {
    const record = {
      id: 'memory-null',
      memory: 'No metadata here.',
      agent_id: 'ac:agent:bot-a',
      hash: 'hash-null',
      metadata: null,
      created_at: '2026-07-16T00:00:00Z',
      updated_at: '2026-07-16T00:01:00Z'
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/search' && req.method === 'POST') return send(res, 200, { results: [record] })
      if (url.pathname === '/memories' && req.method === 'GET') return send(res, 200, { results: [record] })
      if (url.pathname === '/memories/memory-null/history' && req.method === 'GET') {
        return send(res, 200, [
          {
            id: 'history-null',
            memory_id: 'memory-null',
            new_memory: 'No metadata here.',
            event: 'ADD',
            created_at: '2026-07-16T00:00:00Z',
            updated_at: '2026-07-16T00:01:00Z',
            metadata: null
          }
        ])
      }
      if (url.pathname === '/memories/memory-null' && req.method === 'GET') return send(res, 200, record)
      return send(res, 404, { detail: 'not found' })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('null-metadata fixture failed to bind')
    closers.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    )
    const client = new Mem0OssClient({ baseUrl: `http://127.0.0.1:${address.port}` })

    const recalled = await client.recall({ context, query: 'anything', topK: 5, maxBytes: 8_192 }, 'secret')
    expect(recalled.records).toEqual([expect.objectContaining({ id: 'memory-null', scope: context.scope })])
    const listed = await client.list({ context, limit: 5 }, 'secret')
    expect(listed.records).toEqual([expect.objectContaining({ id: 'memory-null' })])
    const got = await client.get({ context, id: 'memory-null' }, 'secret')
    expect(got.record).toEqual(expect.objectContaining({ id: 'memory-null' }))
    const history = await client.history({ context, id: 'memory-null', limit: 5 }, 'secret')
    expect(history.events).toEqual([expect.objectContaining({ id: 'history-null', event: 'create' })])
  })

  it('accepts the pinned OSS single-record score null before reading history', async () => {
    const requests: string[] = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      requests.push(url.pathname)
      if (url.pathname === '/memories/memory-pinned' && req.method === 'GET') {
        return send(res, 200, {
          id: 'memory-pinned',
          memory: 'Pinned Mem0 history regression fixture.',
          hash: 'hash-pinned',
          metadata: { source: 'agentconnect-regression' },
          score: null,
          created_at: '2026-07-19T05:00:04.670936+00:00',
          updated_at: '2026-07-19T05:00:04.670936+00:00',
          agent_id: 'ac:agent:bot-a',
          role: 'user'
        })
      }
      if (url.pathname === '/memories/memory-pinned/history' && req.method === 'GET') {
        return send(res, 200, [
          {
            id: 'history-pinned',
            memory_id: 'memory-pinned',
            old_memory: null,
            new_memory: 'Pinned Mem0 history regression fixture.',
            event: 'ADD',
            created_at: '2026-07-19T05:00:04.670936+00:00',
            updated_at: '2026-07-19T05:00:04.670936+00:00',
            is_deleted: false,
            actor_id: null,
            role: 'user'
          }
        ])
      }
      return send(res, 404, { detail: 'not found' })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('pinned-score fixture failed to bind')
    closers.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    )
    const client = new Mem0OssClient({ baseUrl: `http://127.0.0.1:${address.port}` })

    await expect(client.history({ context, id: 'memory-pinned', limit: 5 }, 'secret')).resolves.toEqual({
      events: [expect.objectContaining({ id: 'history-pinned', event: 'create' })]
    })
    expect(requests).toEqual(['/memories/memory-pinned', '/memories/memory-pinned/history'])
  })

  it('still rejects a non-object metadata value instead of silently accepting it', async () => {
    const server = createServer((_req, res) =>
      send(res, 200, {
        results: [
          {
            id: 'memory-bad',
            memory: 'Bad metadata.',
            agent_id: 'ac:agent:bot-a',
            hash: 'hash-bad',
            metadata: 'not-an-object'
          }
        ]
      })
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('bad-metadata fixture failed to bind')
    closers.push(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    )
    const client = new Mem0OssClient({ baseUrl: `http://127.0.0.1:${address.port}` })
    await expect(client.recall({ context, query: 'anything', topK: 5, maxBytes: 8_192 }, 'secret')).rejects.toThrow()
  })
})
