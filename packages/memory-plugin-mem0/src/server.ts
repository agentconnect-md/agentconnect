import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  MEMORY_PLUGIN_ERROR_TOKEN,
  MEMORY_PLUGIN_PROFILE,
  MEMORY_PLUGIN_TOOL,
  MemoryPluginCaptureInput,
  MemoryPluginCaptureOutput,
  MemoryPluginDeleteInput,
  MemoryPluginDeleteOutput,
  MemoryPluginGetInput,
  MemoryPluginGetOutput,
  MemoryPluginHistoryInput,
  MemoryPluginHistoryOutput,
  MemoryPluginListInput,
  MemoryPluginListOutput,
  MemoryPluginManifest,
  MemoryPluginOperationStatusInput,
  MemoryPluginOperationStatusOutput,
  MemoryPluginRecallInput,
  MemoryPluginRecallOutput,
  type MemoryPluginManifest as Manifest
} from '@agentconnect.md/protocol'
import { MEM0_CLOUD_API, Mem0CloudClient, Mem0CloudConflictError, type Mem0CloudClientOptions } from './cloud.js'

const MAX_MCP_REQUEST_BYTES = 512 * 1024
const API_KEY_HEADER = 'x-mem0-api-key'

export interface MemoryPluginCredentialExtra {
  requestInfo?: { headers: Record<string, string | string[] | undefined> }
}
export type MemoryPluginCredentialSource = (extra: MemoryPluginCredentialExtra) => string

export const MEM0_CLOUD_MANIFEST: Manifest = {
  profile: MEMORY_PLUGIN_PROFILE,
  plugin: { id: 'ai.mem0.memory', version: '1.0.0' },
  connection: {
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    secretFields: [{ name: 'apiKey', required: true, transportHeader: 'X-Mem0-Api-Key' }]
  },
  capabilities: {
    scopes: ['agent'],
    operations: ['recall', 'capture', 'list', 'get', 'delete', 'history'],
    asyncCapture: true,
    // Mem0 does not document an idempotency key for V3 add.
    idempotency: 'none'
  },
  limits: { maxQueryBytes: 16 * 1024, maxRecordBytes: 32 * 1024, maxBatchItems: 20 },
  declaredEgressHosts: ['api.mem0.ai']
}

function header(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const direct = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(direct)) return direct.length === 1 ? direct[0] : undefined
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue
    return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value
  }
  return undefined
}

export function requestHeaderCredential(headerName: string): MemoryPluginCredentialSource {
  return (extra) => {
    const value = header(extra.requestInfo?.headers, headerName)?.trim()
    if (!value) throw new Error('memory backend credential is unavailable')
    return value
  }
}

const cloudHttpCredential = requestHeaderCredential(API_KEY_HEADER)

function result(structuredContent: Record<string, unknown>, label: string) {
  return {
    content: [{ type: 'text' as const, text: label }],
    structuredContent
  }
}

function conflictResult() {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: MEMORY_PLUGIN_ERROR_TOKEN.conflict }]
  }
}

export function createMem0CloudMcpServer(
  client = new Mem0CloudClient(),
  credential: MemoryPluginCredentialSource = cloudHttpCredential
): McpServer {
  const server = new McpServer({ name: 'agentconnect-memory-mem0-cloud', version: '1.0.0' })

  server.registerTool(
    MEMORY_PLUGIN_TOOL.manifest,
    {
      description: 'Return the pinned AgentConnect memory-plugin profile manifest',
      inputSchema: z.object({}).strict(),
      outputSchema: MemoryPluginManifest
    },
    async () => result(MEM0_CLOUD_MANIFEST as unknown as Record<string, unknown>, 'manifest ready')
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.recall,
    {
      description: 'Recall bounded records from Mem0 Cloud V3 for the trusted agent scope',
      inputSchema: MemoryPluginRecallInput,
      outputSchema: MemoryPluginRecallOutput
    },
    async (input, extra) => {
      const output = await client.recall(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'recall completed')
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.capture,
    {
      description: 'Queue one bounded delivered turn in the Mem0 Cloud V3 additive pipeline',
      inputSchema: MemoryPluginCaptureInput,
      outputSchema: MemoryPluginCaptureOutput
    },
    async (input, extra) => {
      const output = await client.capture(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'capture submitted')
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.operationStatus,
    {
      description: 'Poll a Mem0 Cloud async event without reading memory bodies',
      inputSchema: MemoryPluginOperationStatusInput,
      outputSchema: MemoryPluginOperationStatusOutput
    },
    async (input, extra) => {
      const output = await client.operationStatus(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'capture status checked')
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.list,
    {
      description: 'List a bounded page of Mem0 Cloud records for the trusted agent scope',
      inputSchema: MemoryPluginListInput,
      outputSchema: MemoryPluginListOutput
    },
    async (input, extra) => {
      const output = await client.list(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'memory page listed')
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.get,
    {
      description: 'Get one Mem0 Cloud record after verifying its trusted agent scope',
      inputSchema: MemoryPluginGetInput,
      outputSchema: MemoryPluginGetOutput
    },
    async (input, extra) => {
      const output = await client.get(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'memory retrieved')
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.delete,
    {
      description: 'Delete one Mem0 Cloud record after verifying its trusted agent scope',
      inputSchema: MemoryPluginDeleteInput,
      outputSchema: MemoryPluginDeleteOutput
    },
    async (input, extra) => {
      try {
        const output = await client.delete(input, credential(extra), extra.signal)
        return result(output as unknown as Record<string, unknown>, 'memory delete completed')
      } catch (error) {
        if (error instanceof Mem0CloudConflictError) return conflictResult()
        throw error
      }
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.history,
    {
      description: 'Read a bounded page of Mem0 Cloud record history for the trusted agent scope',
      inputSchema: MemoryPluginHistoryInput,
      outputSchema: MemoryPluginHistoryOutput
    },
    async (input, extra) => {
      const output = await client.history(input, credential(extra), extra.signal)
      return result(output as unknown as Record<string, unknown>, 'memory history listed')
    }
  )

  return server
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) throw Object.assign(new Error(), { status: 413 })
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.byteLength
    if (bytes > MAX_MCP_REQUEST_BYTES) throw Object.assign(new Error(), { status: 413 })
    chunks.push(part)
  }
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error(), { status: 400 })
  }
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export interface Mem0CloudServerOptions extends Mem0CloudClientOptions {
  host?: string
  port?: number
}

export interface RunningMem0CloudServer {
  url: string
  close(): Promise<void>
}

export interface MemoryPluginHttpServerOptions {
  host?: string
  port?: number
  createMcpServer: () => McpServer
}

export async function startMemoryPluginHttpServer(
  options: MemoryPluginHttpServerOptions
): Promise<RunningMem0CloudServer> {
  const host = options.host ?? '0.0.0.0'
  const port = options.port ?? 8788
  // Stateless Streamable HTTP creates an isolated MCP server/transport per HTTP
  // request. Initialize, notifications, and calls do not rely on server-local
  // session state; the daemon sends the complete trusted context each time.
  const active = new Set<McpServer>()
  const http: Server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/healthz') return plain(res, 200, 'ok\n')
      if (path !== '/mcp') return plain(res, 404, 'not found\n')
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      const mcp = options.createMcpServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      active.add(mcp)
      res.once('close', () => {
        active.delete(mcp)
        void mcp.close().catch(() => undefined)
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (res.headersSent) return res.destroy()
      const status =
        typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
          ? error.status
          : 500
      plain(res, status, status === 413 ? 'request too large\n' : status === 400 ? 'invalid request\n' : 'failed\n')
    }
  })
  http.listen(port, host)
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Mem0 memory plugin failed to bind')
  const publicHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  let closePromise: Promise<void> | undefined
  return {
    url: `http://${publicHost}:${address.port}/mcp`,
    close() {
      closePromise ??= (async () => {
        const closing = new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve()))
        )
        // Do not let a client keep-alive socket stall deploy shutdown forever.
        http.closeAllConnections()
        await closing
        await Promise.allSettled([...active].map((server) => server.close()))
      })()
      return closePromise
    }
  }
}

export async function startMem0CloudServer(options: Mem0CloudServerOptions = {}): Promise<RunningMem0CloudServer> {
  const client = new Mem0CloudClient({
    baseUrl: options.baseUrl ?? MEM0_CLOUD_API,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.now ? { now: options.now } : {})
  })
  return startMemoryPluginHttpServer({
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    createMcpServer: () => createMem0CloudMcpServer(client)
  })
}
