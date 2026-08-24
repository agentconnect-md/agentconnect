import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MEMORY_PLUGIN_ERROR_TOKEN,
  MEMORY_PLUGIN_PROFILE,
  MEMORY_PLUGIN_TOOL,
  type MemoryPluginManifest
} from '@agentconnect.md/protocol'
import {
  MemoryPluginClient,
  MemoryPluginConflictError,
  MemoryPluginProtocolError,
  assertMemoryConnectionConfig,
  assertMemoryConnectionConfigSchema,
  memoryPluginManifestDigest
} from '../src/memory-plugin/client.js'

type JsonObject = Record<string, unknown>
type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: JsonObject; isError?: boolean }

const context = {
  requestId: 'request-1',
  connection: { id: 'connection-1', config: { projectId: 'project-1' } },
  scope: { kind: 'agent' as const, key: 'ac:agent:agent-1' }
}

const baseManifest: MemoryPluginManifest = {
  profile: MEMORY_PLUGIN_PROFILE,
  plugin: { id: 'ai.example.memory', version: '1.2.3' },
  connection: {
    configSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', title: 'Project ID' } },
      required: ['projectId'],
      additionalProperties: false
    },
    secretFields: [{ name: 'apiKey', required: true, transportHeader: 'Authorization' }]
  },
  capabilities: {
    scopes: ['agent'],
    operations: ['recall', 'capture'],
    asyncCapture: false,
    idempotency: 'operation-id'
  },
  limits: { maxQueryBytes: 4_096, maxRecordBytes: 8_192, maxBatchItems: 20 },
  declaredEgressHosts: ['api.example.com']
}

const schemas: Record<string, { input: string[]; output: string[] }> = {
  [MEMORY_PLUGIN_TOOL.manifest]: {
    input: [],
    output: ['profile', 'plugin', 'connection', 'capabilities', 'limits']
  },
  [MEMORY_PLUGIN_TOOL.recall]: { input: ['context', 'query', 'topK', 'maxBytes'], output: ['records'] },
  [MEMORY_PLUGIN_TOOL.capture]: { input: ['context', 'operationId', 'turn'], output: ['state'] },
  [MEMORY_PLUGIN_TOOL.health]: { input: ['context'], output: ['status'] },
  [MEMORY_PLUGIN_TOOL.operationStatus]: { input: ['context', 'operationId'], output: ['state'] },
  [MEMORY_PLUGIN_TOOL.list]: { input: ['context'], output: ['records'] },
  [MEMORY_PLUGIN_TOOL.get]: { input: ['context', 'id'], output: ['record'] },
  [MEMORY_PLUGIN_TOOL.create]: { input: ['context', 'operationId', 'text'], output: ['record'] },
  [MEMORY_PLUGIN_TOOL.update]: { input: ['context', 'operationId', 'id', 'text'], output: ['record'] },
  [MEMORY_PLUGIN_TOOL.delete]: { input: ['context', 'operationId', 'id'], output: ['deleted'] },
  [MEMORY_PLUGIN_TOOL.history]: { input: ['context', 'id'], output: ['events'] }
}

const schemaType: Record<string, string> = {
  profile: 'string',
  plugin: 'object',
  connection: 'object',
  capabilities: 'object',
  limits: 'object',
  context: 'object',
  query: 'string',
  topK: 'integer',
  maxBytes: 'integer',
  operationId: 'string',
  turn: 'object',
  state: 'string',
  status: 'string',
  records: 'array',
  record: 'object',
  id: 'string',
  text: 'string',
  deleted: 'boolean',
  events: 'array'
}

function objectSchema(required: string[], wrongTypeFor?: string, nullableFor?: string): JsonObject {
  return {
    type: 'object',
    properties: Object.fromEntries(
      required.map((key) => [
        key,
        { type: key === wrongTypeFor ? 'boolean' : key === nullableFor ? [schemaType[key], 'null'] : schemaType[key] }
      ])
    ),
    required,
    additionalProperties: true
  }
}

function memoryRecord(text = 'The deploy region is sea.') {
  return {
    id: 'record-1',
    text,
    scope: context.scope,
    score: 0.9,
    version: 'v1',
    provenance: { pluginId: baseManifest.plugin.id }
  }
}

interface FakeOptions {
  manifest?: MemoryPluginManifest
  omit?: string[]
  add?: string[]
  listPagination?: { pageCount: number; delayMs: number }
  wrongOutputSchemaFor?: string
  nonNullableGetOutput?: boolean
  wrongInputTypeFor?: { tool: string; field: string }
  textOnlyFor?: string
  delayFor?: { tool: string; ms: number }
  holdFor?: { tool: string; arrived: () => void; released: Promise<void> }
  hugeFor?: { tool: string; bytes: number }
  resultFor?: Partial<Record<string, ToolResult>>
}

const liveServers: Array<{ close(): Promise<void> }> = []
const stdioFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'memory-plugin-stdio.mjs')

describe('memory plugin connection config validation', () => {
  it('accepts the bounded reviewed subset and validates the config instance', () => {
    const schema = {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 2, maxLength: 32 },
        region: { type: 'string', enum: ['us', 'eu'] },
        retries: { type: 'integer', minimum: 0, maximum: 5 },
        labels: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        selector: { type: 'object', const: { tier: 'gold' }, default: { tier: 'gold' } }
      },
      required: ['projectId'],
      additionalProperties: false
    }
    expect(() => assertMemoryConnectionConfigSchema(schema)).not.toThrow()
    expect(() =>
      assertMemoryConnectionConfig(
        { projectId: 'p1', region: 'us', retries: 2, labels: ['prod'], selector: { tier: 'gold' } },
        schema
      )
    ).not.toThrow()
  })

  it('rejects missing/unknown/wrong-type/out-of-bounds values', () => {
    const schema = {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 2 },
        retries: { type: 'integer', maximum: 5 }
      },
      required: ['projectId'],
      additionalProperties: false
    }
    expect(() => assertMemoryConnectionConfig({}, schema)).toThrow('missing projectId')
    expect(() => assertMemoryConnectionConfig({ projectId: 'p1', extra: true }, schema)).toThrow(
      'unsupported field extra'
    )
    expect(() => assertMemoryConnectionConfig({ projectId: 1 }, schema)).toThrow('wrong type')
    expect(() => assertMemoryConnectionConfig({ projectId: 'p1', retries: 6 }, schema)).toThrow('exceeds maximum')

    let nested: Record<string, unknown> = {}
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested }
    expect(() =>
      assertMemoryConnectionConfig(nested, { type: 'object', properties: {}, additionalProperties: true })
    ).toThrow('too deeply nested')
  })

  it('rejects malformed or executable schema features before reading config', () => {
    expect(() =>
      assertMemoryConnectionConfigSchema({
        type: 'object',
        properties: { endpoint: { type: 'string', format: 'html' } }
      })
    ).toThrow('unsupported format')
    expect(() =>
      assertMemoryConnectionConfigSchema({
        type: 'object',
        properties: {},
        required: ['missing']
      })
    ).toThrow('.required is invalid')
  })
})

async function startFake(options: FakeOptions = {}): Promise<{
  url: string
  calls: Array<{ name: string; args: unknown }>
  listRequests: Array<string | undefined>
}> {
  const manifest = options.manifest ?? baseManifest
  const names = new Set<string>([
    MEMORY_PLUGIN_TOOL.manifest,
    MEMORY_PLUGIN_TOOL.recall,
    MEMORY_PLUGIN_TOOL.capture,
    ...(options.add ?? [])
  ])
  for (const name of options.omit ?? []) names.delete(name)
  const calls: Array<{ name: string; args: unknown }> = []
  const listRequests: Array<string | undefined> = []
  const tools = [...names].map((name) => {
    const shape = schemas[name] ?? { input: [], output: [] }
    return {
      name,
      description: `fake ${name}`,
      inputSchema: objectSchema(
        shape.input,
        options.wrongInputTypeFor?.tool === name ? options.wrongInputTypeFor.field : undefined
      ),
      outputSchema: objectSchema(
        name === options.wrongOutputSchemaFor ? [] : shape.output,
        undefined,
        name === MEMORY_PLUGIN_TOOL.get && !options.nonNullableGetOutput ? 'record' : undefined
      )
    }
  })

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
  }
  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json)
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') return send(res, 405, { error: 'standalone SSE disabled' })
      if (req.method === 'DELETE') return send(res, 200, {})
      if (req.method !== 'POST') return send(res, 405, { error: 'method' })
      const body = (await readBody(req)) as JsonObject
      if (body.method === 'notifications/initialized') return send(res, 202)
      const id = body.id
      if (body.method === 'initialize') {
        return send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-agentconnect-memory-plugin', version: '1.0.0' }
          }
        })
      }
      if (body.method === 'tools/list') {
        const params = body.params as JsonObject | undefined
        const cursor = typeof params?.cursor === 'string' ? params.cursor : undefined
        listRequests.push(cursor)
        const pagination = options.listPagination
        if (pagination) {
          await new Promise((resolve) => setTimeout(resolve, pagination.delayMs))
          const page = cursor === undefined ? 0 : Number(cursor)
          const nextPage = page + 1
          return send(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              tools: nextPage === pagination.pageCount ? tools : [],
              ...(nextPage < pagination.pageCount ? { nextCursor: String(nextPage) } : {})
            }
          })
        }
        return send(res, 200, { jsonrpc: '2.0', id, result: { tools } })
      }
      if (body.method !== 'tools/call') {
        return send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'not found' } })
      }
      const params = body.params as JsonObject
      const name = String(params.name)
      calls.push({ name, args: params.arguments })
      if (options.delayFor?.tool === name) await new Promise((resolve) => setTimeout(resolve, options.delayFor!.ms))
      if (options.holdFor?.tool === name) {
        options.holdFor.arrived()
        await options.holdFor.released
      }
      let result: ToolResult
      if (options.resultFor?.[name]) result = options.resultFor[name]!
      else if (name === MEMORY_PLUGIN_TOOL.manifest) {
        result = { content: [{ type: 'text', text: 'manifest' }], structuredContent: manifest as unknown as JsonObject }
      } else if (name === MEMORY_PLUGIN_TOOL.recall) {
        result = { content: [{ type: 'text', text: 'recall' }], structuredContent: { records: [memoryRecord()] } }
      } else if (name === MEMORY_PLUGIN_TOOL.capture || name === MEMORY_PLUGIN_TOOL.operationStatus) {
        result = { content: [{ type: 'text', text: 'capture' }], structuredContent: { state: 'completed' } }
      } else if (name === MEMORY_PLUGIN_TOOL.health) {
        result = { content: [{ type: 'text', text: 'health' }], structuredContent: { status: 'ready' } }
      } else if (name === MEMORY_PLUGIN_TOOL.list) {
        result = { content: [{ type: 'text', text: 'list' }], structuredContent: { records: [memoryRecord()] } }
      } else if (name === MEMORY_PLUGIN_TOOL.get) {
        result = { content: [{ type: 'text', text: 'get' }], structuredContent: { record: memoryRecord() } }
      } else if (name === MEMORY_PLUGIN_TOOL.create || name === MEMORY_PLUGIN_TOOL.update) {
        result = { content: [{ type: 'text', text: name }], structuredContent: { record: memoryRecord() } }
      } else if (name === MEMORY_PLUGIN_TOOL.delete) {
        result = { content: [{ type: 'text', text: 'delete' }], structuredContent: { deleted: true } }
      } else {
        result = { content: [{ type: 'text', text: 'history' }], structuredContent: { events: [] } }
      }
      if (options.textOnlyFor === name) delete result.structuredContent
      if (options.hugeFor?.tool === name) result.content[0]!.text = 'x'.repeat(options.hugeFor.bytes)
      return send(res, 200, { jsonrpc: '2.0', id, result })
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'fake failed' })
      else res.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake memory plugin did not bind')
  const running = {
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  }
  liveServers.push(running)
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls, listRequests }
}

afterEach(async () => {
  await Promise.all(liveServers.splice(0).map((server) => server.close()))
})

describe('MemoryPluginClient conformance over operator-owned stdio', () => {
  it('spawns one isolated child, delivers only the mapped environment, and closes it', async () => {
    const previous = process.env.AGENTCONNECT_MEMORY_AMBIENT_SENTINEL
    process.env.AGENTCONNECT_MEMORY_AMBIENT_SENTINEL = 'must-not-reach-child'
    let client: MemoryPluginClient | undefined
    try {
      client = await MemoryPluginClient.connect({
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        env: { MEM0_API_KEY: 'fixture-secret' },
        expectedPluginId: 'ai.example.memory.stdio'
      })
      const response = await client.recall({ context, query: 'local?', topK: 1, maxBytes: 8_192 })
      expect(response.records).toEqual([
        expect.objectContaining({
          id: 'stdio-record-1',
          text: 'stdio transport is isolated',
          scope: context.scope,
          provenance: { pluginId: 'ai.example.memory.stdio' }
        })
      ])
    } finally {
      await client?.close().catch(() => undefined)
      if (previous === undefined) delete process.env.AGENTCONNECT_MEMORY_AMBIENT_SENTINEL
      else process.env.AGENTCONNECT_MEMORY_AMBIENT_SENTINEL = previous
    }
  })

  it.each(['oversize', 'malformed'])('fails conformance and terminates a %s stdio child', async (mode) => {
    await expect(
      MemoryPluginClient.connect({
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture, mode],
        env: { MEM0_API_KEY: 'fixture-secret' },
        maxResponseBytes: 8_192,
        connectTimeoutMs: 1_000
      })
    ).rejects.toBeInstanceOf(MemoryPluginProtocolError)
  })
})

describe('MemoryPluginClient conformance over remote Streamable HTTP', () => {
  it('pins the manifest, recalls only the trusted scope, and captures with a stable operation id', async () => {
    const fake = await startFake()
    const client = await MemoryPluginClient.connect({
      url: fake.url,
      expectedPluginId: baseManifest.plugin.id,
      expectedManifestDigest: memoryPluginManifestDigest(baseManifest)
    })
    expect(client.manifest).toEqual(baseManifest)
    const recalled = await client.recall({ context, query: 'where do we deploy?', topK: 5, maxBytes: 8_192 })
    expect(recalled.records).toEqual([memoryRecord()])
    await expect(
      client.capture({
        context,
        operationId: 'op-' + randomUUID(),
        turn: { turnId: 'turn-1', sessionId: 'session-1', input: 'remember this', output: 'done' }
      })
    ).resolves.toEqual({ state: 'completed' })
    expect(fake.calls.map((call) => call.name)).toEqual([
      MEMORY_PLUGIN_TOOL.manifest,
      MEMORY_PLUGIN_TOOL.recall,
      MEMORY_PLUGIN_TOOL.capture
    ])
    await client.close()
  })

  it('keeps one absolute conformance timeout across paginated tool discovery', async () => {
    const pageCount = 6
    const slow = await startFake({ listPagination: { pageCount, delayMs: 80 } })

    await expect(MemoryPluginClient.connect({ url: slow.url, callTimeoutMs: 120 })).rejects.toThrow(
      'memory plugin conformance probe timed out'
    )
    expect(slow.listRequests.length).toBeGreaterThan(0)
    expect(slow.listRequests.length).toBeLessThan(pageCount)
  })

  it('rejects a missing required tool and a free-text-only result', async () => {
    const missing = await startFake({ omit: [MEMORY_PLUGIN_TOOL.capture] })
    await expect(MemoryPluginClient.connect({ url: missing.url })).rejects.toThrow(
      `missing required tool ${MEMORY_PLUGIN_TOOL.capture}`
    )

    const textOnly = await startFake({ textOnlyFor: MEMORY_PLUGIN_TOOL.manifest })
    await expect(MemoryPluginClient.connect({ url: textOnly.url })).rejects.toThrow('structured output validation')
  })

  it('rejects a required tool whose outputSchema does not promise the canonical result', async () => {
    const fake = await startFake({ wrongOutputSchemaFor: MEMORY_PLUGIN_TOOL.recall })
    await expect(MemoryPluginClient.connect({ url: fake.url })).rejects.toThrow('outputSchema must require records')

    const wrongInput = await startFake({
      wrongInputTypeFor: { tool: MEMORY_PLUGIN_TOOL.recall, field: 'query' }
    })
    await expect(MemoryPluginClient.connect({ url: wrongInput.url })).rejects.toThrow(
      'inputSchema query must be string'
    )
  })

  it('requires the canonical nullable get result in an optional CRUD tool schema', async () => {
    const fake = await startFake({
      manifest: {
        ...baseManifest,
        capabilities: { ...baseManifest.capabilities, operations: ['recall', 'capture', 'get'] }
      },
      add: [MEMORY_PLUGIN_TOOL.get],
      nonNullableGetOutput: true
    })
    await expect(MemoryPluginClient.connect({ url: fake.url })).rejects.toThrow(
      'outputSchema record must be object|null'
    )
  })

  it('rejects manifest/tool capability contradictions and unsafe connection schemas', async () => {
    const mismatchManifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: ['recall', 'capture', 'delete'] }
    }
    const mismatch = await startFake({ manifest: mismatchManifest })
    await expect(MemoryPluginClient.connect({ url: mismatch.url })).rejects.toThrow('manifest/tool mismatch for delete')

    const unsafeManifest = {
      ...baseManifest,
      connection: { ...baseManifest.connection, configSchema: { type: 'object', properties: {}, $ref: 'https://x' } }
    } as MemoryPluginManifest
    const unsafe = await startFake({ manifest: unsafeManifest })
    await expect(MemoryPluginClient.connect({ url: unsafe.url })).rejects.toThrow('keyword $ref is not supported')

    const reservedHeaderManifest: MemoryPluginManifest = {
      ...baseManifest,
      connection: {
        ...baseManifest.connection,
        secretFields: [{ name: 'apiKey', required: true, transportHeader: 'Host' }]
      }
    }
    const reserved = await startFake({ manifest: reservedHeaderManifest })
    await expect(MemoryPluginClient.connect({ url: reserved.url })).rejects.toThrow('reserved transport header')

    const multiScope = await startFake({
      manifest: {
        ...baseManifest,
        capabilities: { ...baseManifest.capabilities, scopes: ['agent', 'user'] }
      }
    })
    await expect(MemoryPluginClient.connect({ url: multiScope.url })).rejects.toThrow(
      'v1 supports only the agent scope'
    )

    const oversizedRecordLimit = await startFake({
      manifest: {
        ...baseManifest,
        limits: { ...baseManifest.limits, maxRecordBytes: 128 * 1024 + 1 }
      }
    })
    await expect(MemoryPluginClient.connect({ url: oversizedRecordLimit.url })).rejects.toThrow(
      'maxRecordBytes exceeds the core transport limit'
    )
  })

  it('rejects plugin-id, profile-major, and digest pin mismatches', async () => {
    const byId = await startFake()
    await expect(MemoryPluginClient.connect({ url: byId.url, expectedPluginId: 'ai.other.memory' })).rejects.toThrow(
      'plugin id does not match'
    )
    const byMajor = await startFake()
    await expect(MemoryPluginClient.connect({ url: byMajor.url, expectedProfileMajor: 2 })).rejects.toThrow(
      'profile major 2 is unsupported'
    )
    const byDigest = await startFake()
    await expect(
      MemoryPluginClient.connect({ url: byDigest.url, expectedManifestDigest: 'sha256:' + '0'.repeat(64) })
    ).rejects.toThrow('manifest digest does not match')

    const additiveManifest = { ...baseManifest, futureOptionalCapability: { enabled: true } }
    const additive = await startFake({ manifest: additiveManifest as MemoryPluginManifest })
    await expect(
      MemoryPluginClient.connect({
        url: additive.url,
        expectedManifestDigest: memoryPluginManifestDigest(baseManifest)
      })
    ).rejects.toThrow('manifest digest does not match')
  })

  it('rejects credential-bearing endpoints and invalid transport budgets before connecting', async () => {
    await expect(MemoryPluginClient.connect({ url: 'https://user:secret@example.com/mcp' })).rejects.toThrow(
      'must not contain credentials'
    )
    await expect(MemoryPluginClient.connect({ url: 'https://example.com/mcp', callTimeoutMs: 0 })).rejects.toThrow(
      'callTimeoutMs is outside the supported range'
    )
    await expect(
      MemoryPluginClient.connect({ url: 'https://example.com/mcp', connectTimeoutMs: Infinity })
    ).rejects.toThrow('connectTimeoutMs is outside the supported range')
  })

  it('rejects out-of-scope, over-budget, and oversized responses', async () => {
    const outOfScope = await startFake({
      resultFor: {
        [MEMORY_PLUGIN_TOOL.recall]: {
          content: [{ type: 'text', text: 'bad' }],
          structuredContent: { records: [{ ...memoryRecord(), scope: { kind: 'agent', key: 'ac:agent:other' } }] }
        }
      }
    })
    const scoped = await MemoryPluginClient.connect({ url: outOfScope.url })
    await expect(scoped.recall({ context, query: 'q', topK: 5, maxBytes: 8_192 })).rejects.toThrow(
      'outside the trusted scope'
    )
    await scoped.close()

    const forgedProvenance = await startFake({
      resultFor: {
        [MEMORY_PLUGIN_TOOL.recall]: {
          content: [{ type: 'text', text: 'bad provenance' }],
          structuredContent: {
            records: [{ ...memoryRecord(), provenance: { pluginId: 'ai.other.memory' } }]
          }
        }
      }
    })
    const provenanceClient = await MemoryPluginClient.connect({ url: forgedProvenance.url })
    await expect(provenanceClient.recall({ context, query: 'q', topK: 5, maxBytes: 8_192 })).rejects.toThrow(
      'forged provenance'
    )
    await provenanceClient.close()

    const overBudget = await startFake({
      resultFor: {
        [MEMORY_PLUGIN_TOOL.recall]: {
          content: [{ type: 'text', text: 'large' }],
          structuredContent: { records: [memoryRecord('x'.repeat(100))] }
        }
      }
    })
    const budgeted = await MemoryPluginClient.connect({ url: overBudget.url })
    await expect(budgeted.recall({ context, query: 'q', topK: 5, maxBytes: 16 })).rejects.toThrow(
      'exceeded the requested text budget'
    )
    await budgeted.close()

    const huge = await startFake({ hugeFor: { tool: MEMORY_PLUGIN_TOOL.recall, bytes: 20_000 } })
    const capped = await MemoryPluginClient.connect({ url: huge.url, maxResponseBytes: 8_192 })
    await expect(capped.recall({ context, query: 'q', topK: 5, maxBytes: 8_192 })).rejects.toThrow()
    await capped.close()
  })

  it('applies trusted scope and identity checks to optional record operations', async () => {
    const listManifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: ['recall', 'capture', 'list'] }
    }
    const outOfScope = await startFake({
      manifest: listManifest,
      add: [MEMORY_PLUGIN_TOOL.list],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.list]: {
          content: [{ type: 'text', text: 'bad list' }],
          structuredContent: {
            records: [{ ...memoryRecord(), scope: { kind: 'agent', key: 'ac:agent:other' } }]
          }
        }
      }
    })
    const listClient = await MemoryPluginClient.connect({ url: outOfScope.url })
    await expect(listClient.list({ context, limit: 10 })).rejects.toThrow('outside the trusted scope')
    await listClient.close()

    const getManifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: ['recall', 'capture', 'get'] }
    }
    const wrongId = await startFake({
      manifest: getManifest,
      add: [MEMORY_PLUGIN_TOOL.get],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.get]: {
          content: [{ type: 'text', text: 'bad get' }],
          structuredContent: { record: { ...memoryRecord(), id: 'another-record' } }
        }
      }
    })
    const getClient = await MemoryPluginClient.connect({ url: wrongId.url })
    await expect(getClient.get({ context, id: 'record-1' })).rejects.toThrow('record with the wrong id')
    await getClient.close()
  })

  it('bounds aggregate record responses and rejects oversized writes before dispatch', async () => {
    const operations = ['recall', 'capture', 'list', 'create', 'update'] as const
    const manifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: [...operations] },
      limits: { ...baseManifest.limits, maxRecordBytes: 120_000 }
    }
    const largeRecords = [memoryRecord('x'.repeat(100_000)), { ...memoryRecord('y'.repeat(100_000)), id: 'record-2' }]
    const fake = await startFake({
      manifest,
      add: [MEMORY_PLUGIN_TOOL.list, MEMORY_PLUGIN_TOOL.create, MEMORY_PLUGIN_TOOL.update],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.list]: {
          content: [{ type: 'text', text: 'large list' }],
          structuredContent: { records: largeRecords }
        }
      }
    })
    const client = await MemoryPluginClient.connect({ url: fake.url })
    await expect(client.list({ context, limit: 10 })).rejects.toThrow('collection exceeds the core transport limit')

    const beforeWrites = fake.calls.length
    await expect(client.create({ context, operationId: 'create-large', text: 'x'.repeat(120_000) })).rejects.toThrow(
      'write exceeds the plugin manifest limit'
    )
    await expect(
      client.update({ context, operationId: 'update-large', id: 'record-1', text: 'x'.repeat(120_000) })
    ).rejects.toThrow('write exceeds the plugin manifest limit')
    expect(fake.calls).toHaveLength(beforeWrites)
    await client.close()
  })

  it('honours per-call timeout and AbortSignal cancellation', async () => {
    const slow = await startFake({ delayFor: { tool: MEMORY_PLUGIN_TOOL.recall, ms: 250 } })
    const client = await MemoryPluginClient.connect({ url: slow.url })
    await expect(client.recall({ context, query: 'q', topK: 5, maxBytes: 8_192 }, { timeoutMs: 20 })).rejects.toThrow()
    const controller = new AbortController()
    const pending = client.recall({ context, query: 'q2', topK: 5, maxBytes: 8_192 }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    await client.close()
  })

  it('includes concurrency-queue time in the call timeout', async () => {
    const slow = await startFake({ delayFor: { tool: MEMORY_PLUGIN_TOOL.recall, ms: 150 } })
    const client = await MemoryPluginClient.connect({ url: slow.url, maxConcurrent: 1 })
    const first = client.recall({ context, query: 'first', topK: 5, maxBytes: 8_192 })
    await vi.waitFor(() => expect(slow.calls.filter((call) => call.name === MEMORY_PLUGIN_TOOL.recall)).toHaveLength(1))

    await expect(
      client.recall({ context, query: 'queued', topK: 5, maxBytes: 8_192 }, { timeoutMs: 20 })
    ).rejects.toThrow('timed out before dispatch')
    await expect(first).resolves.toMatchObject({ records: [memoryRecord()] })
    expect(slow.calls.filter((call) => call.name === MEMORY_PLUGIN_TOOL.recall)).toHaveLength(1)
    await client.close()
  })

  it('gives capture its own budget so a write slower than the generic call timeout still completes', async () => {
    // Capture must not be bound by the recall/generic timeout (a healthy Mem0 `infer: true` outruns it).
    let captureArrived!: () => void
    let releaseCapture!: () => void
    const arrived = new Promise<void>((resolve) => (captureArrived = resolve))
    const released = new Promise<void>((resolve) => (releaseCapture = resolve))
    const slow = await startFake({ holdFor: { tool: MEMORY_PLUGIN_TOOL.capture, arrived: captureArrived, released } })
    // The reply is held while the FAKE clock runs the generic budget out — no real sleep to race CI load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      // Generous real-clock budgets: the connect-time conformance probe also runs under callTimeoutMs.
      const client = await MemoryPluginClient.connect({
        url: slow.url,
        callTimeoutMs: 30_000,
        captureTimeoutMs: 60_000
      })
      const pending = client.capture({
        context,
        operationId: 'op-slow',
        turn: { turnId: 'turn-slow', input: 'in', output: 'out' }
      })
      pending.catch(() => undefined) // a regression rejects mid-advance; keep that handled for the assert below
      await arrived
      await vi.advanceTimersByTimeAsync(45_000) // past callTimeoutMs, within captureTimeoutMs
      releaseCapture()
      await expect(pending).resolves.toEqual({ state: 'completed' })
      vi.useRealTimers()
      await client.close()
    } finally {
      releaseCapture() // on any earlier failure, unblock the fake so afterEach can close it
      vi.useRealTimers()
    }
  })

  it('still surfaces a capture that exceeds its own budget so the outbox can mark delivery unknown', async () => {
    const slow = await startFake({ delayFor: { tool: MEMORY_PLUGIN_TOOL.capture, ms: 120 } })
    const client = await MemoryPluginClient.connect({ url: slow.url, captureTimeoutMs: 30 })
    await expect(
      client.capture({ context, operationId: 'op-lost', turn: { turnId: 'turn-lost', input: 'in', output: 'out' } })
    ).rejects.toThrow()
    await client.close()
  })

  it('rejects an out-of-range capture timeout budget before connecting', async () => {
    await expect(MemoryPluginClient.connect({ url: 'https://example.com/mcp', captureTimeoutMs: 0 })).rejects.toThrow(
      'captureTimeoutMs is outside the supported range'
    )
  })

  it('requires an async declaration and backend operation id for accepted capture', async () => {
    const sync = await startFake({
      resultFor: {
        [MEMORY_PLUGIN_TOOL.capture]: {
          content: [{ type: 'text', text: 'accepted' }],
          structuredContent: { state: 'accepted', backendOperationId: 'backend-1' }
        }
      }
    })
    const syncClient = await MemoryPluginClient.connect({ url: sync.url })
    await expect(
      syncClient.capture({
        context,
        operationId: 'operation-1',
        turn: { turnId: 'turn-1', input: 'in', output: 'out' }
      })
    ).rejects.toThrow('without declaring async capture')
    await syncClient.close()

    const asyncManifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, asyncCapture: true }
    }
    const missingId = await startFake({
      manifest: asyncManifest,
      add: [MEMORY_PLUGIN_TOOL.operationStatus],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.capture]: {
          content: [{ type: 'text', text: 'accepted' }],
          structuredContent: { state: 'accepted' }
        },
        [MEMORY_PLUGIN_TOOL.operationStatus]: {
          content: [{ type: 'text', text: 'still accepted' }],
          structuredContent: { state: 'accepted' }
        }
      }
    })
    const asyncClient = await MemoryPluginClient.connect({ url: missingId.url })
    await expect(
      asyncClient.capture({
        context,
        operationId: 'operation-2',
        turn: { turnId: 'turn-2', input: 'in', output: 'out' }
      })
    ).rejects.toThrow('without a backend operation id')
    await expect(asyncClient.operationStatus({ context, operationId: 'operation-2' })).rejects.toThrow(
      'without a backend operation id'
    )
    await asyncClient.close()
  })

  it('enables every optional CRUD/history operation only through its declared capability', async () => {
    const operations = ['recall', 'capture', 'list', 'get', 'create', 'update', 'delete', 'history'] as const
    const manifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: [...operations] }
    }
    const fake = await startFake({
      manifest,
      add: [
        MEMORY_PLUGIN_TOOL.list,
        MEMORY_PLUGIN_TOOL.get,
        MEMORY_PLUGIN_TOOL.create,
        MEMORY_PLUGIN_TOOL.update,
        MEMORY_PLUGIN_TOOL.delete,
        MEMORY_PLUGIN_TOOL.history
      ]
    })
    const client = await MemoryPluginClient.connect({ url: fake.url })
    await expect(client.list({ context, limit: 10 })).resolves.toMatchObject({ records: [memoryRecord()] })
    await expect(client.get({ context, id: 'record-1' })).resolves.toMatchObject({ record: memoryRecord() })
    await expect(client.create({ context, operationId: 'create-1', text: 'fact' })).resolves.toMatchObject({
      record: memoryRecord()
    })
    await expect(
      client.update({ context, operationId: 'update-1', id: 'record-1', text: 'new fact', version: 'v1' })
    ).resolves.toMatchObject({ record: memoryRecord() })
    await expect(client.delete({ context, operationId: 'delete-1', id: 'record-1', version: 'v1' })).resolves.toEqual({
      deleted: true
    })
    await expect(client.history({ context, id: 'record-1', limit: 10 })).resolves.toEqual({ events: [] })
    await client.close()

    const minimal = await startFake()
    const minimalClient = await MemoryPluginClient.connect({ url: minimal.url })
    expect(() => minimalClient.delete({ context, operationId: 'x', id: 'record-1' })).toThrow(MemoryPluginProtocolError)
    await minimalClient.close()
  })

  it('accepts only the stable conflict token and never exposes plugin error text', async () => {
    const manifest: MemoryPluginManifest = {
      ...baseManifest,
      capabilities: { ...baseManifest.capabilities, operations: ['recall', 'capture', 'update'] }
    }
    const conflict = await startFake({
      manifest,
      add: [MEMORY_PLUGIN_TOOL.update],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.update]: {
          isError: true,
          content: [{ type: 'text', text: MEMORY_PLUGIN_ERROR_TOKEN.conflict }]
        }
      }
    })
    const client = await MemoryPluginClient.connect({ url: conflict.url })
    await expect(
      client.update({ context, operationId: 'update-conflict', id: 'record-1', text: 'replacement', version: 'v1' })
    ).rejects.toBeInstanceOf(MemoryPluginConflictError)
    await client.close()

    const unstructured = await startFake({
      manifest,
      add: [MEMORY_PLUGIN_TOOL.update],
      resultFor: {
        [MEMORY_PLUGIN_TOOL.update]: {
          isError: true,
          content: [{ type: 'text', text: 'private record body and secret' }]
        }
      }
    })
    const sanitized = await MemoryPluginClient.connect({ url: unstructured.url })
    const attempt = sanitized.update({
      context,
      operationId: 'update-error',
      id: 'record-1',
      text: 'replacement',
      version: 'v1'
    })
    await expect(attempt).rejects.toThrow('returned an error result')
    await expect(attempt).rejects.not.toThrow(/private record body|secret/)
    await sanitized.close()
  })
})
