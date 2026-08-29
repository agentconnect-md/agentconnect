import { describe, it, expect, vi, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpControlServer, type McpControlDeps } from '../src/mcp/control-server.js'
import { buildMcpServers } from '../src/mcp/inject.js'
import { decodeFrames, encodeFrame, type IpcPrivateRequest, type IpcResponse } from '../src/mcp/ipc.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { MessageGateway } from '../src/mcp/ops.js'

// The real CLI entry, invoked the same way buildMcpServers() does in dev:
// current interpreter + execArgv (carries the tsx loader under vitest) + entry.
const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))

const tools = toolsForIntegrations(
  [
    {
      id: 'int-1',
      platform: 'slack',
      core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
      config: { botToken: 'x', appToken: 'y' }
    }
  ],
  { sessionTitle: true }
)

/** The bridge only exercises the tools these deps back; the rest are never dispatched. */
const controlDeps = (deps: Partial<McpControlDeps>): McpControlDeps => deps as McpControlDeps

let server: McpControlServer | undefined
let privateServer: net.Server | undefined
const privateSockets = new Set<net.Socket>()
const bridges = new Set<ChildProcess>()
const tempRoots: string[] = []
let client: Client | undefined
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const resolved = realpathSync(root)
  expect(resolved).not.toBe(repoRoot)
  expect(resolved.startsWith(repoRoot + sep)).toBe(false)
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  for (const bridge of bridges) if (bridge.exitCode === null) bridge.kill('SIGKILL')
  bridges.clear()
  await client?.close().catch(() => {})
  await server?.stop()
  for (const socket of privateSockets) socket.destroy()
  privateSockets.clear()
  if (privateServer?.listening) {
    await new Promise<void>((resolve) => privateServer!.close(() => resolve()))
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  server = privateServer = client = undefined
})

describe('mcp-bridge end-to-end (real stdio MCP handshake)', () => {
  it('lists daemon tools and routes a sendMessage call back to the gateway', async () => {
    const root = tempRoot('ac-e2e-')
    const path = join(root, 'mcp.sock')
    const gw: MessageGateway = {
      postMessage: vi.fn(async () => 'ts-42'),
      getChannelInfo: vi.fn(async (id) => ({ id })),
      listMembers: vi.fn(async () => []),
      listChannels: vi.fn(async () => []),
      getUserProfile: vi.fn(async (u) => ({ id: u })),
      downloadFile: vi.fn(async () => null)
    }
    const recorded: unknown[] = []
    const titleUpdates: unknown[] = []
    server = new McpControlServer(
      controlDeps({
        socketPath: path,
        setSessionTitle: async (req) => {
          titleUpdates.push(req)
        },
        gatewayFor: () => gw,
        recordOutbound: async (_c, channel, _t, text, ts) => {
          recorded.push({ channel, text, ts })
        },
        now: () => 0
      })
    )
    await server.start()
    const token = server.register({
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-1',
      isDm: false,
      channel: 'C9',
      thread: '5.5',
      tools
    })

    const [spec] = buildMcpServers({ socketPath: path, token, cliEntry })
    client = new Client({ name: 'test-harness', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: spec!.command,
        // Run the .ts entry under the tsx loader. In prod buildMcpServers points
        // at the compiled dist; here we exercise source (inject args are covered
        // by mcp-inject.test). process.execArgv under vitest carries no TS loader.
        // `--conditions development` makes the child resolve workspace deps (e.g.
        // @agentconnect.md/protocol) via their `development` → src export, matching
        // how vitest resolves them in-process, so this test needs no prior build.
        args: ['--conditions', 'development', '--import', 'tsx', cliEntry, 'mcp-bridge'],
        env: Object.fromEntries(spec!.env.map((e) => [e.name, e.value]))
      })
    )

    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toContain('sendMessage')
    expect(listed.tools.map((t) => t.name)).toContain('setSessionTitle')

    const titleOut = await client.callTool({ name: 'setSessionTitle', arguments: { title: '  Review\nPR  ' } })
    expect(titleOut.isError).toBeFalsy()
    expect(titleUpdates).toEqual([
      {
        agentId: 'bot-a',
        platform: 'slack',
        integrationId: 'int-1',
        isDm: false,
        channel: 'C9',
        thread: '5.5',
        title: 'Review PR'
      }
    ])

    const out = await client.callTool({
      name: 'sendMessage',
      arguments: { toUser: 'U9', channel: 'C9', message: 'e2e hi' }
    })
    expect(out.isError).toBeFalsy()
    // No `thread` ⇒ post to the channel ROOT (undefined), not the current thread.
    expect(gw.postMessage).toHaveBeenCalledWith('C9', '<@U9> e2e hi', undefined, { agentAuthorId: 'bot-a' })
    expect(recorded).toEqual([{ channel: 'C9', text: '<@U9> e2e hi', ts: 'ts-42' }])
  })

  it('does not expose private stdio MCP until its persistent UDS attach is ACKed', async () => {
    const root = tempRoot('ac-private-bridge-attach-')
    const path = join(root, 'mcp.sock')
    let acknowledgeAttach!: () => void
    const attachGate = new Promise<void>((resolve) => (acknowledgeAttach = resolve))
    let observeAttach!: () => void
    const attachObserved = new Promise<void>((resolve) => (observeAttach = resolve))
    privateServer = net.createServer((socket) => {
      privateSockets.add(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('close', () => privateSockets.delete(socket))
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const decoded = decodeFrames<IpcPrivateRequest>(buffer)
        buffer = decoded.rest
        for (const request of decoded.messages) {
          if (request.op !== 'attach') {
            socket.write(encodeFrame({ id: request.id, ok: false, error: 'attach required' }))
            continue
          }
          observeAttach()
          void attachGate.then(() => {
            if (!socket.destroyed) {
              socket.write(encodeFrame({ id: request.id, ok: true, result: { attached: true } }))
            }
          })
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      privateServer!.once('error', reject)
      privateServer!.listen(path, resolve)
    })

    const [spec] = buildMcpServers({
      socketPath: path,
      token: 'private-token',
      cliEntry,
      lazyTools: true
    })
    client = new Client({ name: 'private-attach-test', version: '0.0.0' })
    let stdioReady = false
    const connecting = client
      .connect(
        new StdioClientTransport({
          command: spec!.command,
          args: ['--conditions', 'development', '--import', 'tsx', cliEntry, 'mcp-bridge', '--lazy-tools'],
          env: Object.fromEntries(spec!.env.map((entry) => [entry.name, entry.value]))
        })
      )
      .then(() => {
        stdioReady = true
      })

    await expect(
      Promise.race([attachObserved.then(() => 'attached'), connecting.then(() => 'stdio-ready')])
    ).resolves.toBe('attached')
    expect(stdioReady).toBe(false)
    acknowledgeAttach()
    await connecting
    expect(stdioReady).toBe(true)
  })

  it('keeps a private lazy bridge alive across first-list failure and preserves native MCP errors', async () => {
    const root = tempRoot('ac-private-bridge-e2e-')
    const path = join(root, 'mcp.sock')
    let listAttempts = 0
    const errorContent = new Map([
      ['forbidden', [{ type: 'text', text: 'Request failed (HTTP 403): forbidden' }]],
      ['precondition', [{ type: 'text', text: 'confirmation mismatch' }]],
      ['invalid', [{ type: 'text', text: 'invalid arguments' }]],
      ['rate-limit', [{ type: 'text', text: 'rate limit exceeded' }]]
    ])
    const tools = [...errorContent.keys()].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }))
    const requestOps: string[] = []
    privateServer = net.createServer((socket) => {
      privateSockets.add(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('close', () => privateSockets.delete(socket))
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const decoded = decodeFrames<IpcPrivateRequest>(buffer)
        buffer = decoded.rest
        for (const request of decoded.messages) {
          requestOps.push(request.op)
          let response: IpcResponse
          if (request.op === 'attach') {
            response = { id: request.id, ok: true, result: { attached: true } }
          } else if (request.op === 'listTools' && listAttempts++ === 0) {
            response = { id: request.id, ok: false, error: 'control plane offline' }
          } else if (request.op === 'listTools') {
            response = { id: request.id, ok: true, result: { tools } }
          } else {
            response = {
              id: request.id,
              ok: true,
              result: { mcpContent: errorContent.get(request.name), mcpIsError: true }
            }
          }
          socket.write(encodeFrame(response))
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      privateServer!.once('error', reject)
      privateServer!.listen(path, resolve)
    })

    const [spec] = buildMcpServers({
      socketPath: path,
      token: 'private-token',
      cliEntry,
      lazyTools: true
    })
    client = new Client({ name: 'private-test-harness', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: spec!.command,
        args: ['--conditions', 'development', '--import', 'tsx', cliEntry, 'mcp-bridge', '--lazy-tools'],
        env: Object.fromEntries(spec!.env.map((entry) => [entry.name, entry.value]))
      })
    )

    expect(requestOps).toEqual(['attach'])
    await expect(client.listTools()).rejects.toThrow(/control plane offline/)
    await expect(client.listTools()).resolves.toMatchObject({ tools })
    await Promise.all(
      [...errorContent].map(async ([name, content]) => {
        await expect(client!.callTool({ name, arguments: {} })).resolves.toEqual({
          content,
          isError: true
        })
      })
    )
  })

  // A bridge that outlives its harness holds ~230 MB of RSS per session for the daemon's
  // lifetime (#936), so both ends of its lifetime have to terminate the process.
  describe('lifetime', () => {
    // Answers listTools so the bridge reaches its serving state, and reports when it got there.
    async function serveBridge(socketPath: string): Promise<{ listed: Promise<void> }> {
      let observeList!: () => void
      const listed = new Promise<void>((resolve) => (observeList = resolve))
      privateServer = net.createServer((socket) => {
        privateSockets.add(socket)
        socket.setEncoding('utf8')
        let buffer = ''
        socket.on('close', () => privateSockets.delete(socket))
        socket.on('data', (chunk: string) => {
          buffer += chunk
          const decoded = decodeFrames<IpcPrivateRequest>(buffer)
          buffer = decoded.rest
          for (const request of decoded.messages) {
            socket.write(encodeFrame({ id: request.id, ok: true, result: { tools: [] } }))
            observeList()
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        privateServer!.once('error', reject)
        privateServer!.listen(socketPath, resolve)
      })
      return { listed }
    }

    // Spawned the way an agent harness does — stdio pipes we own, so we can close stdin.
    function spawnBridge(socketPath: string): ChildProcess {
      const child = spawn(
        process.execPath,
        ['--conditions', 'development', '--import', 'tsx', cliEntry, 'mcp-bridge'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, AC_MCP_ENDPOINT: socketPath, AC_MCP_TOKEN: 'lifetime-token' }
        }
      )
      bridges.add(child)
      return child
    }

    function exitOf(child: ChildProcess): Promise<number | null> {
      return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
    }

    it('exits when the harness closes its stdin', async () => {
      const path = join(tempRoot('ac-bridge-stdin-'), 'mcp.sock')
      const { listed } = await serveBridge(path)
      const bridge = spawnBridge(path)
      await listed
      // What a dying harness does to the bridge: EOF on stdin, control socket still live.
      bridge.stdin!.end()
      await expect(exitOf(bridge)).resolves.toBe(0)
    })

    it('exits when the daemon control socket closes', async () => {
      const path = join(tempRoot('ac-bridge-socket-'), 'mcp.sock')
      const { listed } = await serveBridge(path)
      const bridge = spawnBridge(path)
      await listed
      // stdin stays open here: only the daemon went away, as on a daemon restart.
      for (const socket of privateSockets) socket.destroy()
      await expect(exitOf(bridge)).resolves.toBe(1)
    })
  })
})
