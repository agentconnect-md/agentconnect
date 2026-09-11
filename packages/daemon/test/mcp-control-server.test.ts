import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpControlServer, type McpControlDeps } from '../src/mcp/control-server.js'
import { mcpSocketPath } from '../src/paths.js'
import { encodeFrame, decodeFrames, type IpcPrivateRequest, type IpcResponse } from '../src/mcp/ipc.js'
import type { MessageGateway, SessionContext } from '../src/mcp/ops.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import { ASK_STUB_KEY, ASK_STUB_TOOL, askStubDescriptor } from './ask-stub-tool.js'

// The ask mechanism has no product call site yet, so a test-only tool stands in for one. It is
// routed through the REAL `executeTool`, which is also how it reaches the ask port this server
// injects per call — the thing under test.
vi.mock('../src/mcp/ops.js', async (importOriginal) => {
  // Imported inside the factory: `vi.mock` is hoisted above every top-level binding in this file.
  const { opsWithAskStub } = await import('./ask-stub-tool.js')
  return opsWithAskStub(await importOriginal())
})

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
const tempRoots: string[] = []

function socketPath() {
  const root = mkdtempSync(join(tmpdir(), 'ac-mcp-'))
  const resolved = realpathSync(root)
  expect(resolved).not.toBe(repoRoot)
  expect(resolved.startsWith(repoRoot + sep)).toBe(false)
  tempRoots.push(root)
  return mcpSocketPath(root)
}

function gateway(): MessageGateway {
  return {
    postMessage: vi.fn(async () => 'ts-9'),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general' })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u: string) => ({ id: u }))
  } as unknown as MessageGateway
}

const tools = toolsForIntegrations([
  {
    id: 'int-1',
    platform: 'slack',
    core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
    config: { botToken: 'x', appToken: 'y' }
  }
])

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  agentId: 'bot-a',
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C1',
  thread: '1.1',
  tools,
  ...over
})

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never

/** Open a client socket and run one request/response exchange. */
function rpc(path: string, req: Unsent<IpcPrivateRequest>): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(encodeFrame({ id: 1, ...req } as IpcPrivateRequest)))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const { messages } = decodeFrames<IpcResponse>(buf)
      if (messages.length) {
        sock.end()
        resolve(messages[0]!)
      }
    })
    sock.on('error', reject)
  })
}

/** The tests drive only the IPC surface, so the ops deps behind it stay unbuilt. */
const controlDeps = (over: Partial<McpControlDeps>): McpControlDeps => over as McpControlDeps

let server: McpControlServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('McpControlServer IPC', () => {
  it('listTools returns the registered session tools', async () => {
    const path = socketPath()
    server = new McpControlServer(
      controlDeps({ socketPath: path, gatewayFor: gateway, recordOutbound: async () => {}, now: () => 0 })
    )
    await server.start()
    const token = server.register(ctx())

    const res = await rpc(path, { token, op: 'listTools' })
    expect(res.ok).toBe(true)
    const result = res.result as { tools: { name: string }[] }
    expect(result.tools.map((t) => t.name)).toContain('sendMessage')
  })

  it('callTool runs sendMessage (channel post) through the gateway and records it', async () => {
    const path = socketPath()
    const gw = gateway()
    const recorded: unknown[] = []
    server = new McpControlServer(
      controlDeps({
        socketPath: path,
        gatewayFor: () => gw,
        recordOutbound: async (_c, channel, _t, text, ts) => {
          recorded.push({ channel, text, ts })
        },
        now: () => 0
      })
    )
    await server.start()
    const token = server.register(ctx())

    const res = await rpc(path, {
      token,
      op: 'callTool',
      name: 'sendMessage',
      args: { toUser: 'U9', channel: 'C1', message: 'hello' }
    })
    expect(res.ok).toBe(true)
    // A deliberate sendMessage with no `thread` posts to the channel ROOT (undefined), not the
    // current thread — "reply here" is the agent's normal turn output.
    expect(gw.postMessage).toHaveBeenCalledWith('C1', '<@U9> hello', undefined, { agentAuthorId: 'bot-a' })
    expect(recorded).toEqual([{ channel: 'C1', text: '<@U9> hello', ts: 'ts-9' }])
  })

  it('rejects an unknown/expired token', async () => {
    const path = socketPath()
    server = new McpControlServer(
      controlDeps({ socketPath: path, gatewayFor: gateway, recordOutbound: async () => {}, now: () => 0 })
    )
    await server.start()

    const res = await rpc(path, { token: 'bogus', op: 'listTools' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/token/)
  })

  it('rejects the private attach op without affecting ordinary shared bridge requests', async () => {
    const path = socketPath()
    server = new McpControlServer(
      controlDeps({ socketPath: path, gatewayFor: gateway, recordOutbound: async () => {}, now: () => 0 })
    )
    await server.start()
    const token = server.register(ctx())

    await expect(rpc(path, { token, op: 'attach' })).resolves.toMatchObject({ ok: false })
    await expect(rpc(path, { token, op: 'listTools' })).resolves.toMatchObject({ ok: true })
  })

  it('stop() resolves promptly even with a live client connection open', async () => {
    const path = socketPath()
    const srv = new McpControlServer(
      controlDeps({ socketPath: path, gatewayFor: gateway, recordOutbound: async () => {}, now: () => 0 })
    )
    await srv.start()
    // Hold an open connection; without socket teardown server.close() would hang.
    const client = net.connect(path)
    await new Promise<void>((resolve) => client.on('connect', () => resolve()))
    await expect(srv.stop()).resolves.toBeUndefined()
    client.destroy()
  })

  it('returns ok:false (not a crash) when a tool throws', async () => {
    const path = socketPath()
    const gw = gateway()
    ;(gw.postMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('slack down'))
    server = new McpControlServer(
      controlDeps({ socketPath: path, gatewayFor: () => gw, recordOutbound: async () => {}, now: () => 0 })
    )
    await server.start()
    const token = server.register(ctx())

    const res = await rpc(path, {
      token,
      op: 'callTool',
      name: 'sendMessage',
      args: { toUser: 'U9', channel: 'C1', message: 'x' }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/slack down/)
  })
})

const askable = { form: true, url: false }

const askStub = (extra: Record<string, unknown>) => ({
  op: 'callTool' as const,
  name: ASK_STUB_TOOL,
  args: { channel: 'C9', message: 'which bot?' },
  ...extra
})

describe('McpControlServer — MCP-side elicitation (#1965 Gap A)', () => {
  /** One server plus a gateway per offered id, so a post proves WHICH bot the stub acted as. */
  async function askServer(over: Partial<McpControlDeps> = {}) {
    const path = socketPath()
    const gws: Record<string, MessageGateway> = { 'int-a': gateway(), 'int-b': gateway() }
    server = new McpControlServer(
      controlDeps({
        socketPath: path,
        gatewayFor: (id: string) => gws[id],
        recordOutbound: async () => {},
        now: () => 0,
        ...over
      })
    )
    await server.start()
    return { path, gws, token: server.register(ctx({ tools: [...tools, askStubDescriptor] })) }
  }

  it('answers the frame with the ask marker, and the tool does no observable work on that round', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, { token, ...askStub({ ask: askable }) })
    expect(res.ok).toBe(true)
    const { mcpAsk } = res.result as { mcpAsk: { key: string; message: string; requestedSchema: unknown } }
    expect(mcpAsk.key).toBe(ASK_STUB_KEY)
    expect(mcpAsk.message).toMatch(/Which one should send/)
    expect(mcpAsk.requestedSchema).toEqual({
      type: 'object',
      properties: {
        integrationId: {
          type: 'string',
          title: 'Integration',
          description: 'The bot this message is sent from.',
          enum: ['int-a', 'int-b']
        }
      },
      required: ['integrationId']
    })
    expect(gws['int-a']!.postMessage).not.toHaveBeenCalled()
    expect(gws['int-b']!.postMessage).not.toHaveBeenCalled()
  })

  // THE structural guard: an old in-sandbox bridge sends no `ask`, so no tool on it can mint a
  // marker that bridge would JSON.stringify straight to the model — it keeps today's behaviour.
  it('hands no ask port to a request that declares no ask support', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, { token, ...askStub({}) })
    expect(res.ok).toBe(true)
    expect(res.result).not.toHaveProperty('mcpAsk')
    expect(gws['int-a']!.postMessage).toHaveBeenCalledWith('C9', 'which bot?', undefined, { agentAuthorId: 'bot-a' })
  })

  it('hands no ask port to a host that declared URL elicitation only', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, { token, ...askStub({ ask: { form: false, url: true } }) })
    expect(res.ok).toBe(true)
    expect(res.result).not.toHaveProperty('mcpAsk')
    expect(gws['int-a']!.postMessage).toHaveBeenCalled()
  })

  it('re-enters the tool with the answer on the round that carries it', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, {
      token,
      ...askStub({
        ask: askable,
        askAnswers: { [ASK_STUB_KEY]: { action: 'accept', content: { integrationId: 'int-b' } } }
      })
    })
    expect(res.ok).toBe(true)
    expect(gws['int-b']!.postMessage).toHaveBeenCalledWith('C9', 'which bot?', undefined, { agentAuthorId: 'bot-a' })
    expect(gws['int-a']!.postMessage).not.toHaveBeenCalled()
  })

  it('turns a decline into a usable refusal naming the repair, not an exception', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, {
      token,
      ...askStub({ ask: askable, askAnswers: { [ASK_STUB_KEY]: { action: 'decline' } } })
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/pass `integrationId` explicitly \(one of: int-a, int-b\)/)
    expect(gws['int-a']!.postMessage).not.toHaveBeenCalled()
  })

  it('leaves an answer naming something never offered to the tool to refuse', async () => {
    const { path, gws, token } = await askServer()
    const res = await rpc(path, {
      token,
      ...askStub({
        ask: askable,
        askAnswers: { [ASK_STUB_KEY]: { action: 'accept', content: { integrationId: 'int-z' } } }
      })
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/named no known integration/)
    expect(gws['int-a']!.postMessage).not.toHaveBeenCalled()
  })

  // The ask is human-paced, so the turn can die while it is open. The replayed round re-runs the
  // turn gate FIRST and refuses — the documented outcome, and the reason the bridge pins a round
  // timeout well under the SDK's 600s default instead of inheriting it.
  it('lets the turn gate refuse the answer round, doing nothing', async () => {
    const { path, gws, token } = await askServer({ canRun: () => false })
    const res = await rpc(path, {
      token,
      ...askStub({
        ask: askable,
        askAnswers: { [ASK_STUB_KEY]: { action: 'accept', content: { integrationId: 'int-b' } } }
      })
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/this agent turn has been stopped/)
    expect(gws['int-b']!.postMessage).not.toHaveBeenCalled()
  })
})
