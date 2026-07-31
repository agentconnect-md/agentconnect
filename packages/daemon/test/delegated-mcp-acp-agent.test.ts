import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { AcpHost } from '../src/acp/acp-host.js'
import { McpControlServer } from '../src/mcp/control-server.js'
import { buildMcpServers } from '../src/mcp/inject.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'delegated-mcp-acp-agent.mjs')
const cliEntry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const tempRoots: string[] = []
const servers: McpControlServer[] = []
const hosts: AcpHost[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop().catch(() => {})))
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => {})))
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function textUpdates(): { updates: string[]; onUpdate: ConstructorParameters<typeof AcpHost>[1]['onUpdate'] } {
  const updates: string[] = []
  return {
    updates,
    onUpdate: (_sessionId, update) => {
      if (update.sessionUpdate !== 'agent_message_chunk') return
      const content = (update as { content?: { type?: string; text?: string } }).content
      if (content?.type === 'text' && content.text) updates.push(content.text)
    }
  }
}

describe('delegated MCP ACP fixture', () => {
  it('echoes, uses a real stdio MCP client, and reattaches the descriptor on session/load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-delegated-fixture-'))
    tempRoots.push(root)
    const socketPath = join(root, 'mcp.sock')
    const setSessionTitle = vi.fn(async () => {})
    const server = new McpControlServer({
      socketPath,
      setSessionTitle,
      gatewayFor: () => undefined,
      recordOutbound: () => {},
      now: () => 0
    })
    servers.push(server)
    await server.start()

    const tools = toolsForIntegrations([], { sessionTitle: true }).filter((tool) => tool.name === 'setSessionTitle')
    const token = server.register({
      agentId: 'preset-agent',
      platform: 'webchat',
      integrationId: 'webchat',
      isDm: true,
      channel: 'conversation-1',
      tools
    })
    const [descriptor] = buildMcpServers({ socketPath, token, cliEntry, name: 'agentconnect-admin' })
    descriptor!.args = ['--conditions', 'development', '--import', 'tsx', cliEntry, 'mcp-bridge']

    const firstUpdates = textUpdates()
    const first = new AcpHost(
      { command: process.execPath, args: [fixture], env: [] },
      { onUpdate: firstUpdates.onUpdate }
    )
    hosts.push(first)
    await first.start()
    expect(first.loadSupported()).toBe(true)
    const sessionId = await first.newSession(root, [descriptor!])
    await first.prompt(sessionId, [{ type: 'text', text: 'echo:ordinary' }])
    await first.prompt(sessionId, [
      { type: 'text', text: 'Standing AgentConnect context that must not hide the user command.' },
      { type: 'text', text: 'admin:list' }
    ])
    await first.prompt(sessionId, [
      {
        type: 'text',
        text: 'admin:call setSessionTitle {"title":"Fixture title"}'
      }
    ])

    expect(firstUpdates.updates[0]).toBe('echo:ordinary')
    expect(firstUpdates.updates[1]).toBe('admin:list:setSessionTitle')
    expect(firstUpdates.updates[2]).toMatch(/^admin:call:setSessionTitle:/)
    expect(setSessionTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'preset-agent',
        channel: 'conversation-1',
        title: 'Fixture title'
      })
    )

    await first.stop()
    hosts.splice(hosts.indexOf(first), 1)

    const resumedUpdates = textUpdates()
    const resumed = new AcpHost(
      { command: process.execPath, args: [fixture], env: [] },
      { onUpdate: resumedUpdates.onUpdate }
    )
    hosts.push(resumed)
    await resumed.start()
    await resumed.loadSession(sessionId, root, [descriptor!])
    await resumed.prompt(sessionId, [{ type: 'text', text: 'admin:list' }])

    expect(resumedUpdates.updates).toEqual(['admin:list:setSessionTitle'])
    expect(resumedUpdates.updates.join('\n')).not.toMatch(
      new RegExp([socketPath, token, 'AC_MCP_ENDPOINT', 'AC_MCP_TOKEN', 'authorization', 'assertion'].join('|'), 'i')
    )
  }, 30_000)
})
