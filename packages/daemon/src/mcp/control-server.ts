import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { decodeFrames, encodeFrame, type IpcRequest, type IpcResponse } from './ipc.js'
import { executeTool, type OpsDeps, type SessionContext } from './ops.js'
import type { ToolDescriptor } from './tools.js'
import type { Logger } from '../log.js'

export interface McpControlDeps extends OpsDeps {
  socketPath: string
  log?: Logger
}

/**
 * The daemon-hosted half of MCP. It owns all tool logic, the registry of live
 * sessions, and the Unix-domain socket the `mcp-bridge` subprocesses connect to.
 * "The MCP server is the daemon itself" — the bridge is only a stdio↔socket pipe.
 */
export class McpControlServer {
  private server?: net.Server
  private readonly sessions = new Map<string, SessionContext>()
  private readonly conns = new Set<net.Socket>()

  constructor(private deps: McpControlDeps) {}

  /**
   * Register a session's tool set and return an opaque token. The token is
   * embedded in the bridge's env at `session/new`; the bridge presents it on
   * every IPC request so we can resolve the channel/thread/agent binding.
   */
  register(ctx: SessionContext): string {
    const token = randomBytes(18).toString('base64url')
    this.sessions.set(token, ctx)
    return token
  }

  unregister(token: string): void {
    this.sessions.delete(token)
  }

  async start(): Promise<void> {
    if (this.server) return
    const path = this.deps.socketPath
    const dir = dirname(path)
    // 0700 dir + 0600 socket: confine the control socket to the daemon's uid, so
    // a leaked session token isn't the *only* thing standing between a local
    // process and acting as the bot. chmod after mkdir to defeat a loose umask.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* best-effort on platforms without POSIX modes */
    }
    // A stale socket from a crashed daemon makes listen() throw EADDRINUSE.
    rmSync(path, { force: true })

    const server = net.createServer((socket) => this.onConnection(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error) => reject(err)
      server.once('error', onStartupError)
      server.listen(path, () => {
        server.off('error', onStartupError)
        // Keep a persistent handler so a post-startup server error is logged,
        // not thrown as an uncaught 'error' that takes the daemon down.
        server.on('error', (err) => this.deps.log?.error(`mcp: control server error: ${err.message}`))
        resolve()
      })
    })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* best-effort */
    }
    this.deps.log?.info(`mcp: control socket listening at ${path}`)
  }

  private onConnection(socket: net.Socket): void {
    socket.setEncoding('utf8')
    this.conns.add(socket)
    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      const { messages, rest } = decodeFrames<IpcRequest>(buf, (line) =>
        this.deps.log?.debug(`mcp: dropping malformed frame: ${line.slice(0, 120)}`)
      )
      buf = rest
      for (const req of messages) void this.handle(req, socket)
    })
    socket.on('error', (err) => this.deps.log?.debug(`mcp: socket error: ${err.message}`))
    socket.on('close', () => this.conns.delete(socket))
  }

  /**
   * Run a PRODUCT tool on behalf of an evaluation-registry tool
   * (collaboration-arena.md §6). This exists for one purpose: an evaluation
   * façade that presents a different SCHEMA for an existing capability has to
   * compile down to that capability's real implementation, not re-implement it,
   * or an A/B of the two surfaces would not be comparing like with like.
   *
   * It is evaluation-only plumbing and changes no routing, activation or policy:
   * the tool it runs is the same one the model could have called directly, on
   * the same trusted token-bound `SessionContext`. Re-entry is safe because the
   * evaluation registry is consulted by exact name and a product tool never
   * matches it.
   */
  async executeProductTool(ctx: SessionContext, name: string, args: Record<string, unknown>): Promise<unknown> {
    return executeTool(ctx, name, args, this.deps)
  }

  private async handle(req: IpcRequest, socket: net.Socket): Promise<void> {
    const reply = (res: IpcResponse) => {
      if (!socket.destroyed) socket.write(encodeFrame(res))
    }
    const ctx = this.sessions.get(req.token)
    if (!ctx) return reply({ id: req.id, ok: false, error: 'unknown or expired session token' })
    try {
      if (req.op === 'listTools') {
        reply({ id: req.id, ok: true, result: { tools: ctx.tools as ToolDescriptor[] } })
        return
      }
      const result = await executeTool(ctx, req.name, req.args ?? {}, this.deps)
      reply({ id: req.id, ok: true, result })
    } catch (err) {
      reply({ id: req.id, ok: false, error: (err as Error).message })
    }
  }

  async stop(): Promise<void> {
    this.sessions.clear()
    const server = this.server
    if (!server) return
    this.server = undefined
    // Destroy any still-open bridge connections so server.close()'s callback
    // fires promptly instead of waiting on a socket that may outlive us.
    for (const s of this.conns) s.destroy()
    this.conns.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(this.deps.socketPath, { force: true })
  }
}
