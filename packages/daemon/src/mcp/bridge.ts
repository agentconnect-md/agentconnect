import net from 'node:net'
import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { decodeFrames, encodeFrame, type IpcListToolsResult, type IpcResponse } from './ipc.js'
import type { McpContentResult } from './ops.js'

type IpcCall = { op: 'attach' } | { op: 'listTools' } | { op: 'callTool'; name: string; args: Record<string, unknown> }

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
  /** Installed once the bridge serves stdio; a closed control socket then ends the process. */
  onClose?: () => void

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
      this.onClose?.()
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

  async attach(): Promise<void> {
    await this.request({ op: 'attach' })
  }
}

/**
 * The stdio MCP server that relays `tools/list` and `tools/call` to the running
 * daemon over its control socket. The agent harness spawns it per session; the
 * daemon does the real work. Two entries reach it: the daemon's hidden
 * `mcp-bridge` subcommand where the runtime shares this filesystem, and the
 * runtime image's own bundle where it does not (src/shim/mcp-bridge.ts).
 */
export async function runBridge(opts: { lazyTools?: boolean; version?: string } = {}): Promise<void> {
  const endpoint = process.env.AC_MCP_ENDPOINT
  const token = process.env.AC_MCP_TOKEN
  if (!endpoint || !token) {
    process.stderr.write('mcp-bridge: AC_MCP_ENDPOINT and AC_MCP_TOKEN must be set\n')
    process.exit(2)
  }

  const ipc = new IpcClient(endpoint, token)
  let tools: IpcListToolsResult['tools'] | undefined
  if (opts.lazyTools) {
    try {
      // A private bridge is not an MCP server until this exact persistent UDS
      // connection is bound to its active cell. The attach operation performs
      // no CP request and does not discover tools.
      await ipc.attach()
    } catch (err) {
      process.stderr.write(`mcp-bridge: private attach failed: ${(err as Error).message}\n`)
      process.exit(1)
    }
  } else {
    try {
      const res = (await ipc.request({ op: 'listTools' })) as IpcListToolsResult
      tools = res.tools
    } catch (err) {
      process.stderr.write(`mcp-bridge: could not reach daemon: ${(err as Error).message}\n`)
      process.exit(1)
    }
  }

  // Stated by the entry rather than read from a package.json: the in-sandbox bundle is copied into
  // the runtime image on its own, and a manifest beside it would change how node reads every .js there.
  const server = new Server({ name: 'agentconnect', version: opts.version ?? '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', async () => {
    if (tools) return { tools }
    const res = (await ipc.request({ op: 'listTools' })) as IpcListToolsResult
    return { tools: res.tools }
  })
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
        const native = result as McpContentResult
        return { content: native.mcpContent, ...(native.mcpIsError === true ? { isError: true } : {}) }
      }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true }
    }
  })

  // Nothing else settles a request queued after the socket died, so a call would hang forever.
  ipc.onClose = () => {
    process.stderr.write('mcp-bridge: daemon control socket closed, exiting\n')
    process.exit(1)
  }
  // stdin EOF means the harness is gone; the stdio transport never watches for it, so the live socket would strand us.
  const exitWhenHarnessGone = (): void => process.exit(0)
  process.stdin.on('end', exitWhenHarnessGone)
  process.stdin.on('close', exitWhenHarnessGone)

  await server.connect(new StdioServerTransport())
}
