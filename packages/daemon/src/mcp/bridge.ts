import net from 'node:net'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { decodeFrames, encodeFrame, type IpcListToolsResult, type IpcResponse } from './ipc.js'
import type { McpContentResult } from './ops.js'
import { DAEMON_VERSION } from '../version.js'

type IpcCall = { op: 'listTools' } | { op: 'callTool'; name: string; args: Record<string, unknown> }

/**
 * IPC client half of the bridge: a persistent UDS connection to the daemon's
 * control server. Requests are correlated by an incrementing id; an `ok:false`
 * response rejects with the daemon's error message.
 */
class IpcClient {
  private socket: net.Socket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buf = ''
  private ready: Promise<void>

  constructor(
    endpoint: string,
    private token: string
  ) {
    this.socket = net.connect(endpoint)
    this.socket.setEncoding('utf8')
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('data', (chunk: string) => {
      this.buf += chunk
      const { messages, rest } = decodeFrames<IpcResponse>(this.buf)
      this.buf = rest
      for (const res of messages) {
        const p = this.pending.get(res.id)
        if (!p) continue
        this.pending.delete(res.id)
        if (res.ok) p.resolve(res.result)
        else p.reject(new Error(res.error ?? 'tool call failed'))
      }
    })
    this.socket.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('daemon connection closed'))
      this.pending.clear()
    })
  }

  async request(call: IpcCall): Promise<unknown> {
    await this.ready
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(encodeFrame({ id, token: this.token, ...call }))
    })
  }
}

/**
 * Entry point for `agentconnect mcp-bridge`: a stdio MCP server that relays
 * `tools/list` and `tools/call` to the running daemon over its control socket.
 * The agent harness spawns this per session; the daemon does the real work.
 */
export async function runBridge(): Promise<void> {
  const endpoint = process.env.AC_MCP_ENDPOINT
  const token = process.env.AC_MCP_TOKEN
  if (!endpoint || !token) {
    process.stderr.write('mcp-bridge: AC_MCP_ENDPOINT and AC_MCP_TOKEN must be set\n')
    process.exit(2)
  }

  const ipc = new IpcClient(endpoint, token)
  let tools: IpcListToolsResult['tools']
  try {
    const res = (await ipc.request({ op: 'listTools' })) as IpcListToolsResult
    tools = res.tools
  } catch (err) {
    process.stderr.write(`mcp-bridge: could not reach daemon: ${(err as Error).message}\n`)
    process.exit(1)
  }

  const server = new Server({ name: 'agentconnect', version: DAEMON_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', async () => ({ tools }))
  server.setRequestHandler('tools/call', async (req) => {
    try {
      const result = await ipc.request({
        op: 'callTool',
        name: req.params.name,
        args: (req.params.arguments ?? {}) as Record<string, unknown>
      })
      // A tool may return native MCP content (e.g. a viewable image from
      // readSlackFile) via the `mcpContent` marker — pass it through verbatim.
      if (result && typeof result === 'object' && Array.isArray((result as { mcpContent?: unknown }).mcpContent)) {
        return { content: (result as McpContentResult).mcpContent }
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
}
