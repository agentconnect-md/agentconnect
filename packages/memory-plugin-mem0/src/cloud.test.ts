import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MemoryPluginClient,
  MemoryPluginConflictError,
  memoryPluginManifestDigest
} from '../../daemon/src/memory-plugin/client.js'
import { Mem0CloudClient, Mem0CloudConflictError } from './cloud.js'
import { MEM0_CLOUD_MANIFEST, startMem0CloudServer } from './server.js'

interface SeenRequest {
  method: string
  path: string
  authorization?: string
  body?: any
}

const closers: Array<() => Promise<void>> = []

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json)
}

async function startUpstream(
  handler?: (req: IncomingMessage, res: ServerResponse, seen: SeenRequest) => Promise<void> | void
): Promise<{ url: string; requests: SeenRequest[] }> {
  const requests: SeenRequest[] = []
  const server = createServer(async (req, res) => {
    const seen: SeenRequest = {
      method: req.method ?? '',
      path: new URL(req.url ?? '/', 'http://localhost').pathname,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      body: req.method === 'POST' ? await readJson(req) : undefined
    }
    requests.push(seen)
    if (handler) return handler(req, res, seen)
    if (seen.path === '/v3/memories/search/') {
      return send(res, 200, {
        results: [
          {
            id: 'memory-1',
            memory: 'Deploy in sea.',
            score: 0.91,
            metadata: { source: 'turn' },
            categories: ['deployment'],
            created_at: '2026-07-16T00:00:00Z',
            updated_at: '2026-07-16T00:01:00Z'
          }
        ]
      })
    }
    if (seen.path === '/v3/memories/add/') {
      return send(res, 200, { status: 'PENDING', event_id: '11111111-1111-4111-8111-111111111111' })
    }
    if (seen.path === '/v3/memories/') {
      return send(res, 200, {
        count: 2,
        next: `${new URL(req.url ?? '/', 'http://localhost').origin}/v3/memories/?page=2&page_size=1`,
        previous: null,
        results: [
          {
            id: 'memory-1',
            memory: 'Deploy in sea.',
            metadata: { source: 'turn' },
            categories: ['deployment'],
            created_at: '2026-07-16T00:00:00Z',
            updated_at: '2026-07-16T00:01:00Z'
          }
        ]
      })
    }
    if (seen.path === '/v1/memories/memory-1') {
      if (seen.method === 'DELETE') {
        res.writeHead(204).end()
        return
      }
      return send(res, 200, {
        id: 'memory-1',
        memory: 'Deploy in sea.',
        agent_id: 'ac:agent:bot-a',
        hash: 'hash-1',
        metadata: { source: 'turn' },
        created_at: '2026-07-16T00:00:00Z',
        updated_at: '2026-07-16T00:01:00Z'
      })
    }
    if (seen.path === '/v1/memories/memory-1/history') {
      return send(res, 200, [
        {
          id: 'history-1',
          memory_id: 'memory-1',
          new_memory: 'Deploy in sea.',
          event: 'ADD',
          created_at: '2026-07-16T00:00:00Z',
          updated_at: '2026-07-16T00:01:00Z',
          metadata: { source: 'turn' }
        }
      ])
    }
    if (seen.path === '/v1/event/11111111-1111-4111-8111-111111111111/') {
      return send(res, 200, { id: '11111111-1111-4111-8111-111111111111', status: 'SUCCEEDED' })
    }
    return send(res, 404, { error: 'not found' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture failed to bind')
  closers.push(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))))
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

const context = {
  requestId: 'request-1',
  connection: { id: '22222222-2222-4222-8222-222222222222', config: {} },
  scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' }
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('Mem0 Cloud V3 plugin contract', () => {
  it('conforms over Streamable HTTP and maps Cloud V3 plus scoped V1 record operations', async () => {
    const upstream = await startUpstream()
    const plugin = await startMem0CloudServer({ host: '127.0.0.1', port: 0, baseUrl: upstream.url })
    closers.push(() => plugin.close())
    const client = await MemoryPluginClient.connect({
      url: plugin.url,
      headers: [{ name: 'X-Mem0-Api-Key', value: 'cloud-secret' }],
      expectedPluginId: 'ai.mem0.memory',
      expectedManifestDigest: memoryPluginManifestDigest(MEM0_CLOUD_MANIFEST)
    })

    const recalled = await client.recall({ context, query: 'where?', topK: 5, maxBytes: 8_192 })
    expect(recalled.records).toEqual([
      expect.objectContaining({
        id: 'memory-1',
        text: 'Deploy in sea.',
        score: 0.91,
        scope: context.scope,
        provenance: { pluginId: 'ai.mem0.memory', backendId: 'memory-1' }
      })
    ])
    const receipt = await client.capture({
      context,
      operationId: 'ac:capture:operation-1',
      turn: { turnId: 'turn-1', sessionId: 'session-1', input: 'remember', output: 'done' }
    })
    expect(receipt).toEqual({ state: 'accepted', backendOperationId: '11111111-1111-4111-8111-111111111111' })
    await expect(
      client.operationStatus({
        context,
        operationId: 'ac:capture:operation-1',
        backendOperationId: receipt.backendOperationId
      })
    ).resolves.toEqual({ state: 'completed', backendOperationId: receipt.backendOperationId })
    await expect(client.list({ context, limit: 1 })).resolves.toEqual({
      records: [
        expect.objectContaining({
          id: 'memory-1',
          text: 'Deploy in sea.',
          scope: context.scope,
          provenance: { pluginId: 'ai.mem0.memory', backendId: 'memory-1' }
        })
      ],
      nextCursor: '2'
    })
    await expect(client.get({ context, id: 'memory-1' })).resolves.toEqual({
      record: expect.objectContaining({ id: 'memory-1', version: 'hash-1', scope: context.scope })
    })
    await expect(client.history({ context, id: 'memory-1', limit: 1 })).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: 'history-1',
          event: 'create',
          at: '2026-07-16T00:01:00.000Z',
          record: expect.objectContaining({ id: 'memory-1', text: 'Deploy in sea.', scope: context.scope })
        })
      ]
    })
    await expect(
      client.delete({ context, operationId: 'ac:delete:stale', id: 'memory-1', version: 'hash-other' })
    ).rejects.toBeInstanceOf(MemoryPluginConflictError)
    await expect(
      client.delete({ context, operationId: 'ac:delete:operation-1', id: 'memory-1', version: 'hash-1' })
    ).resolves.toEqual({ deleted: true })

    expect(upstream.requests.map((req) => [req.method, req.path])).toEqual([
      ['POST', '/v3/memories/search/'],
      ['POST', '/v3/memories/add/'],
      ['GET', '/v1/event/11111111-1111-4111-8111-111111111111/'],
      ['POST', '/v3/memories/'],
      ['GET', '/v1/memories/memory-1'],
      ['GET', '/v1/memories/memory-1'],
      ['GET', '/v1/memories/memory-1/history'],
      ['GET', '/v1/memories/memory-1'],
      ['GET', '/v1/memories/memory-1'],
      ['DELETE', '/v1/memories/memory-1']
    ])
    expect(upstream.requests.every((req) => req.authorization === 'Token cloud-secret')).toBe(true)
    expect(upstream.requests[0]!.body).toMatchObject({
      query: 'where?',
      filters: { agent_id: 'ac:agent:bot-a' },
      top_k: 5
    })
    expect(upstream.requests[1]!.body).toMatchObject({
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
    await client.close()
  })

  it('never deletes a record outside the trusted scope or at a stale version', async () => {
    const foreign = await startUpstream((_req, res) =>
      send(res, 200, {
        id: 'memory-1',
        memory: 'private',
        agent_id: 'ac:agent:other',
        hash: 'hash-1'
      })
    )
    const foreignClient = new Mem0CloudClient({ baseUrl: foreign.url })
    await expect(
      foreignClient.delete({ context, operationId: 'ac:delete:foreign', id: 'memory-1', version: 'hash-1' }, 'secret')
    ).rejects.toThrow(/outside the trusted scope/)
    expect(foreign.requests.map((request) => request.method)).toEqual(['GET'])

    const stale = await startUpstream()
    const staleClient = new Mem0CloudClient({ baseUrl: stale.url })
    await expect(
      staleClient.delete({ context, operationId: 'ac:delete:stale', id: 'memory-1', version: 'hash-other' }, 'secret')
    ).rejects.toBeInstanceOf(Mem0CloudConflictError)
    expect(stale.requests.map((request) => request.method)).toEqual(['GET'])
  })

  it('maps a definite rejection to failed and an unknown post-send outcome to ambiguous', async () => {
    const request = vi.fn()
    const rejected = await startUpstream((_req, res) => send(res, 429, { detail: 'do not expose this body' }))
    const rejectedClient = new Mem0CloudClient({ baseUrl: rejected.url, metrics: { request } })
    await expect(
      rejectedClient.capture(
        {
          context,
          operationId: 'operation-1',
          turn: { turnId: 'turn-1', input: 'in', output: 'out' }
        },
        'secret'
      )
    ).resolves.toEqual({ state: 'failed' })
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'capture', outcome: 'rate_limited' }))

    const disconnected = await startUpstream((req) => {
      req.socket.destroy()
    })
    const disconnectedClient = new Mem0CloudClient({ baseUrl: disconnected.url, metrics: { request } })
    await expect(
      disconnectedClient.capture(
        {
          context,
          operationId: 'operation-2',
          turn: { turnId: 'turn-2', input: 'in', output: 'out' }
        },
        'secret'
      )
    ).resolves.toEqual({ state: 'ambiguous' })
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'capture', outcome: 'network' }))
  })

  it('rejects a status response correlated to a different backend event', async () => {
    const upstream = await startUpstream((_req, res) => send(res, 200, { id: 'event-other', status: 'SUCCEEDED' }))
    const client = new Mem0CloudClient({ baseUrl: upstream.url })
    await expect(
      client.operationStatus({ context, operationId: 'operation-1', backendOperationId: 'event-expected' }, 'secret')
    ).rejects.toThrow(/mismatched event id/)
  })

  it('never follows an upstream redirect with the credential or turn body', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(307, { location: '/unreviewed-target' }).end()
    })
    const client = new Mem0CloudClient({ baseUrl: upstream.url })
    await expect(
      client.capture(
        {
          context,
          operationId: 'operation-redirect',
          turn: { turnId: 'turn-redirect', input: 'private input', output: 'private output' }
        },
        'secret'
      )
    ).resolves.toEqual({ state: 'ambiguous' })
    expect(upstream.requests.map((request) => request.path)).toEqual(['/v3/memories/add/'])
  })

  it('requires the relay-injected secret header without exposing it in the error', async () => {
    const upstream = await startUpstream()
    const plugin = await startMem0CloudServer({ host: '127.0.0.1', port: 0, baseUrl: upstream.url })
    closers.push(() => plugin.close())
    const client = await MemoryPluginClient.connect({ url: plugin.url })
    await expect(client.recall({ context, query: 'q', topK: 5, maxBytes: 8_192 })).rejects.not.toThrow(
      /cloud-secret|authorization|api.?key/i
    )
    expect(upstream.requests).toEqual([])
    await client.close()
  })
})
