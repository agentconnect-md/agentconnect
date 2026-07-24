import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  MEMORY_PLUGIN_ERROR_TOKEN,
  MEMORY_PLUGIN_PROFILE,
  MEMORY_PLUGIN_TOOL,
  MemoryPluginCaptureInput,
  MemoryPluginCaptureOutput,
  MemoryPluginCreateInput,
  MemoryPluginCreateOutput,
  MemoryPluginDeleteInput,
  MemoryPluginDeleteOutput,
  MemoryPluginGetInput,
  MemoryPluginGetOutput,
  MemoryPluginHistoryInput,
  MemoryPluginHistoryOutput,
  MemoryPluginListInput,
  MemoryPluginListOutput,
  MemoryPluginManifest,
  MemoryPluginRecallInput,
  MemoryPluginRecallOutput,
  type MemoryPluginManifest as Manifest
} from '@agentconnect.md/protocol'
import { MEM0_OSS_DEFAULT_API, Mem0OssClient, Mem0OssConflictError, type Mem0OssClientOptions } from './oss.js'
import {
  requestHeaderCredential,
  startMemoryPluginHttpServer,
  type MemoryPluginCredentialSource,
  type RunningMem0CloudServer
} from './server.js'

const API_KEY_HEADER = 'x-mem0-api-key'
const ossHttpCredential = requestHeaderCredential(API_KEY_HEADER)

export const MEM0_OSS_MANIFEST: Manifest = {
  profile: MEMORY_PLUGIN_PROFILE,
  plugin: { id: 'ai.mem0.memory.oss', version: '1.0.0' },
  connection: {
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    secretFields: [{ name: 'apiKey', required: true, transportHeader: 'X-Mem0-Api-Key' }]
  },
  capabilities: {
    scopes: ['agent'],
    operations: ['recall', 'capture', 'list', 'get', 'create', 'delete', 'history'],
    asyncCapture: false,
    // OSS add is synchronous but does not document operation-id deduplication.
    idempotency: 'none'
  },
  limits: { maxQueryBytes: 16 * 1024, maxRecordBytes: 16 * 1024, maxBatchItems: 20 }
}

function result(structuredContent: Record<string, unknown>, label: string) {
  return { content: [{ type: 'text' as const, text: label }], structuredContent }
}

function conflictResult() {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: MEMORY_PLUGIN_ERROR_TOKEN.conflict }]
  }
}

export function createMem0OssMcpServer(
  client = new Mem0OssClient(),
  credential: MemoryPluginCredentialSource = ossHttpCredential
): McpServer {
  const server = new McpServer({ name: 'agentconnect-memory-mem0-oss', version: '1.0.0' })

  server.registerTool(
    MEMORY_PLUGIN_TOOL.manifest,
    {
      description: 'Return the pinned AgentConnect Mem0 OSS memory-plugin manifest',
      inputSchema: z.object({}).strict(),
      outputSchema: MemoryPluginManifest
    },
    async () => result(MEM0_OSS_MANIFEST as unknown as Record<string, unknown>, 'manifest ready')
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.recall,
    {
      description: 'Recall bounded Mem0 OSS records for the trusted agent scope',
      inputSchema: MemoryPluginRecallInput,
      outputSchema: MemoryPluginRecallOutput
    },
    async (input, extra) =>
      result(
        (await client.recall(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'recall completed'
      )
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.capture,
    {
      description: 'Synchronously capture one bounded delivered turn in Mem0 OSS',
      inputSchema: MemoryPluginCaptureInput,
      outputSchema: MemoryPluginCaptureOutput
    },
    async (input, extra) =>
      result(
        (await client.capture(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'capture completed'
      )
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.list,
    {
      description: 'List a bounded page of Mem0 OSS records for the trusted agent scope',
      inputSchema: MemoryPluginListInput,
      outputSchema: MemoryPluginListOutput
    },
    async (input, extra) =>
      result(
        (await client.list(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'memory page listed'
      )
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.get,
    {
      description: 'Get one Mem0 OSS record after verifying its trusted agent scope',
      inputSchema: MemoryPluginGetInput,
      outputSchema: MemoryPluginGetOutput
    },
    async (input, extra) =>
      result(
        (await client.get(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'memory retrieved'
      )
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.create,
    {
      description: 'Create one exact Mem0 OSS record with inference disabled',
      inputSchema: MemoryPluginCreateInput,
      outputSchema: MemoryPluginCreateOutput
    },
    async (input, extra) =>
      result(
        (await client.create(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'memory created'
      )
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.delete,
    {
      description: 'Delete one Mem0 OSS record after scope and best-effort version checks',
      inputSchema: MemoryPluginDeleteInput,
      outputSchema: MemoryPluginDeleteOutput
    },
    async (input, extra) => {
      try {
        return result(
          (await client.delete(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
          'memory delete completed'
        )
      } catch (error) {
        if (error instanceof Mem0OssConflictError) return conflictResult()
        throw error
      }
    }
  )

  server.registerTool(
    MEMORY_PLUGIN_TOOL.history,
    {
      description: 'Read a bounded page of Mem0 OSS record history for the trusted agent scope',
      inputSchema: MemoryPluginHistoryInput,
      outputSchema: MemoryPluginHistoryOutput
    },
    async (input, extra) =>
      result(
        (await client.history(input, credential(extra), extra.signal)) as unknown as Record<string, unknown>,
        'memory history listed'
      )
  )

  return server
}

export interface Mem0OssServerOptions extends Mem0OssClientOptions {
  host?: string
  port?: number
}

export type RunningMem0OssServer = RunningMem0CloudServer

export async function startMem0OssServer(options: Mem0OssServerOptions = {}): Promise<RunningMem0OssServer> {
  const client = new Mem0OssClient({
    baseUrl: options.baseUrl ?? MEM0_OSS_DEFAULT_API,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.now ? { now: options.now } : {})
  })
  return startMemoryPluginHttpServer({
    ...(options.host ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    createMcpServer: () => createMem0OssMcpServer(client)
  })
}
