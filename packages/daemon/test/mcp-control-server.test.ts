import { describe, it, expect, vi, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpControlServer } from '../src/mcp/control-server.js'
import { encodeFrame, decodeFrames, type IpcRequest, type IpcResponse } from '../src/mcp/ipc.js'
import type { SlackGateway, SessionContext } from '../src/mcp/ops.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'

function socketPath() {
  return join(mkdtempSync(join(tmpdir(), 'ac-mcp-')), 'mcp.sock')
}

function gateway(): SlackGateway {
  return {
    postMessage: vi.fn(async () => 'ts-9'),
    getChannelInfo: vi.fn(async (id) => ({ id, name: 'general' })),
    listMembers: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    getUserProfile: vi.fn(async (u) => ({ id: u }))
  }
}

const tools = toolsForIntegrations([
  { id: 'int-1', platform: 'slack', slack: { botToken: 'x', appToken: 'y', allowedUserIds: [], bindRules: [] } }
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

/** Open a client socket and run one request/response exchange. */
function rpc(path: string, req: Omit<IpcRequest, 'id'>): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(encodeFrame({ id: 1, ...req } as IpcRequest)))
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

let server: McpControlServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

describe('McpControlServer IPC', () => {
  it('listTools returns the registered session tools', async () => {
    const path = socketPath()
    server = new McpControlServer({ socketPath: path, gatewayFor: gateway, recordOutbound: () => {}, now: () => 0 })
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
    server = new McpControlServer({
      socketPath: path,
      gatewayFor: () => gw,
      recordOutbound: (_c, channel, _t, text, ts) => recorded.push({ channel, text, ts }),
      now: () => 0
    })
    await server.start()
    const token = server.register(ctx())

    const res = await rpc(path, {
      token,
      op: 'callTool',
      name: 'sendMessage',
      args: { to: { channel: 'C1' }, message: 'hello' }
    })
    expect(res.ok).toBe(true)
    // A deliberate sendMessage with no `thread` posts to the channel ROOT (undefined), not the
    // current thread — "reply here" is the agent's normal turn output.
    expect(gw.postMessage).toHaveBeenCalledWith('C1', 'hello', undefined)
    expect(recorded).toEqual([{ channel: 'C1', text: 'hello', ts: 'ts-9' }])
  })

  it('rejects an unknown/expired token', async () => {
    const path = socketPath()
    server = new McpControlServer({ socketPath: path, gatewayFor: gateway, recordOutbound: () => {}, now: () => 0 })
    await server.start()

    const res = await rpc(path, { token: 'bogus', op: 'listTools' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/token/)
  })

  it('stop() resolves promptly even with a live client connection open', async () => {
    const path = socketPath()
    const srv = new McpControlServer({ socketPath: path, gatewayFor: gateway, recordOutbound: () => {}, now: () => 0 })
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
    server = new McpControlServer({ socketPath: path, gatewayFor: () => gw, recordOutbound: () => {}, now: () => 0 })
    await server.start()
    const token = server.register(ctx())

    const res = await rpc(path, {
      token,
      op: 'callTool',
      name: 'sendMessage',
      args: { to: { channel: 'C1' }, message: 'x' }
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/slack down/)
  })
})
