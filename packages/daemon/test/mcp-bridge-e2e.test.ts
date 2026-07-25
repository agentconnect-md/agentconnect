import { describe, it, expect, vi, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpControlServer } from '../src/mcp/control-server.js'
import { buildMcpServers } from '../src/mcp/inject.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { SlackGateway } from '../src/mcp/ops.js'

// The real CLI entry, invoked the same way buildMcpServers() does in dev:
// current interpreter + execArgv (carries the tsx loader under vitest) + entry.
const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

const tools = toolsForIntegrations(
  [{ id: 'int-1', platform: 'slack', slack: { botToken: 'x', appToken: 'y', allowedUserIds: [], bindRules: [] } }],
  { sessionTitle: true }
)

let server: McpControlServer | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close().catch(() => {})
  await server?.stop()
  server = client = undefined
})

describe('mcp-bridge end-to-end (real stdio MCP handshake)', () => {
  it('lists daemon tools and routes a sendMessage call back to the gateway', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-e2e-')), 'mcp.sock')
    const gw: SlackGateway = {
      postMessage: vi.fn(async () => 'ts-42'),
      getChannelInfo: vi.fn(async (id) => ({ id })),
      listMembers: vi.fn(async () => []),
      listChannels: vi.fn(async () => []),
      getUserProfile: vi.fn(async (u) => ({ id: u }))
    }
    const recorded: unknown[] = []
    const titleUpdates: unknown[] = []
    server = new McpControlServer({
      socketPath: path,
      setSessionTitle: async (req) => titleUpdates.push(req),
      gatewayFor: () => gw,
      recordOutbound: (_c, channel, _t, text, ts) => recorded.push({ channel, text, ts }),
      now: () => 0
    })
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

    const out = await client.callTool({ name: 'sendMessage', arguments: { to: { channel: 'C9' }, message: 'e2e hi' } })
    expect(out.isError).toBeFalsy()
    // No `thread` ⇒ post to the channel ROOT (undefined), not the current thread.
    expect(gw.postMessage).toHaveBeenCalledWith('C9', 'e2e hi', undefined)
    expect(recorded).toEqual([{ channel: 'C9', text: 'e2e hi', ts: 'ts-42' }])
  }, 20_000)
})
