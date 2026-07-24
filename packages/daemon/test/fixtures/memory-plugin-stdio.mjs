#!/usr/bin/env node

const mode = process.argv[2] ?? 'normal'

const manifest = {
  profile: 'agentconnect.memory/v1',
  plugin: { id: 'ai.example.memory.stdio', version: '1.0.0' },
  connection: {
    configSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
      additionalProperties: false
    },
    secretFields: [{ name: 'apiKey', required: true, transportHeader: 'X-Api-Key' }]
  },
  capabilities: {
    scopes: ['agent'],
    operations: ['recall', 'capture'],
    asyncCapture: false,
    idempotency: 'operation-id'
  },
  limits: { maxQueryBytes: 4096, maxRecordBytes: 8192, maxBatchItems: 20 }
}

const objectSchema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true
})

const tools = [
  {
    name: 'agentconnect_memory_manifest',
    description: 'fixture manifest',
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema(
      {
        profile: { type: 'string' },
        plugin: { type: 'object' },
        connection: { type: 'object' },
        capabilities: { type: 'object' },
        limits: { type: 'object' }
      },
      ['profile', 'plugin', 'connection', 'capabilities', 'limits']
    )
  },
  {
    name: 'agentconnect_memory_recall',
    description: 'fixture recall',
    inputSchema: objectSchema(
      {
        context: { type: 'object' },
        query: { type: 'string' },
        topK: { type: 'integer' },
        maxBytes: { type: 'integer' }
      },
      ['context', 'query', 'topK', 'maxBytes']
    ),
    outputSchema: objectSchema({ records: { type: 'array' } }, ['records'])
  },
  {
    name: 'agentconnect_memory_capture',
    description: 'fixture capture',
    inputSchema: objectSchema(
      { context: { type: 'object' }, operationId: { type: 'string' }, turn: { type: 'object' } },
      ['context', 'operationId', 'turn']
    ),
    outputSchema: objectSchema({ state: { type: 'string' } }, ['state'])
  }
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, structuredContent) {
  send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: 'ok' }], structuredContent }
  })
}

function handle(message) {
  if (message.method === 'initialize') {
    if (mode === 'oversize') {
      process.stdout.write(`${'x'.repeat(16 * 1024)}\n`)
      return
    }
    if (mode === 'malformed') {
      process.stdout.write('{not-json}\n')
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-plugin-stdio-fixture', version: '1.0.0' }
      }
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method !== 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } })
    return
  }
  if (process.env.MEM0_API_KEY !== 'fixture-secret') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'credential unavailable' } })
    return
  }
  if (process.env.AGENTCONNECT_MEMORY_AMBIENT_SENTINEL !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'ambient environment leaked' } })
    return
  }
  if (message.params?.name === 'agentconnect_memory_manifest') return result(message.id, manifest)
  if (message.params?.name === 'agentconnect_memory_recall') {
    const scope = message.params.arguments.context.scope
    return result(message.id, {
      records: [
        {
          id: 'stdio-record-1',
          text: 'stdio transport is isolated',
          scope,
          version: 'v1',
          provenance: { pluginId: manifest.plugin.id }
        }
      ]
    })
  }
  if (message.params?.name === 'agentconnect_memory_capture') return result(message.id, { state: 'completed' })
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'tool not found' } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      process.exitCode = 1
      process.stdin.pause()
      return
    }
  }
})
