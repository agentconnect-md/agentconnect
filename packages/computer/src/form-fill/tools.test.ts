import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Computer } from '../computer.js'
import { startHttpServer, type RunningHttpServer } from '../http-server.js'
import type { McpPrincipal } from '../mcp-access.js'
import { FakeDriver, testConfig } from '../testing.js'
import { createComputerMcpServer } from '../tools.js'
import { FormFillService } from './service.js'

const AGENT = { agentId: '00000000-0000-4000-8000-0000000000aa', sessionId: 'session-1' }
const INTERNAL = ['computer_form_discover', 'computer_form_fill', 'computer_form_status']

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(principal: McpPrincipal) {
  const computer = new Computer({ driver: new FakeDriver(), config: testConfig({ humanIdleSeconds: 0 }) })
  const desktops: string[] = []
  const service = new FormFillService({
    connected: () => true,
    unavailableReason: () => 'not connected',
    request: async (desktop, body) => {
      desktops.push(desktop)
      const { requestId } = body as { requestId: string }
      return {
        type: 'reply',
        id: 1,
        fill: { v: 1, requestId, status: 'filled', fields: [{ field: 'f1', status: 'filled' }], navigated: false }
      }
    }
  })
  running = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    computer,
    authenticate: () => principal,
    createMcpServer: ({ client, agent, viewOnly }) =>
      createComputerMcpServer({
        computer,
        client,
        viewOnly,
        ...(agent ? { agent } : {}),
        formFill: { service, target: async () => ({ computer, desktop: 'd7' }) }
      }),
    log: () => undefined
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))
  return { client, desktops }
}

describe('computer_form_* on the desktop MCP server (computer-form-fill-and-vault.md §5.2)', () => {
  it('is never offered to a local client token', async () => {
    const { client } = await start({ client: 'claude', viewOnly: false })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of INTERNAL) expect(names).not.toContain(name)
    await client.close()
  })

  it("is offered to an agent session's channel token and fills on that agent's desktop", async () => {
    const { client, desktops } = await start({
      client: `${AGENT.agentId}/${AGENT.sessionId}`,
      viewOnly: false,
      agent: AGENT
    })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(INTERNAL))
    const result = (await client.callTool({
      name: 'computer_form_fill',
      arguments: {
        v: 1,
        requestId: '00000000-0000-4000-8000-000000000001',
        target: {
          tabId: 1,
          frameId: 0,
          documentId: 'D0',
          topOrigin: 'https://a.example.test',
          frameOrigin: 'https://a.example.test',
          formId: '0:page'
        },
        values: [{ field: 'f1', value: 'x' }]
      }
    })) as { content: { text: string }[] }
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: 'filled' })
    expect(desktops).toEqual(['d7'])
    await client.close()
  })

  it('offers a view token discovery and status but no fill', async () => {
    const { client } = await start({ client: `${AGENT.agentId}/${AGENT.sessionId}`, viewOnly: true, agent: AGENT })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['computer_form_discover', 'computer_form_status']))
    expect(names).not.toContain('computer_form_fill')
    await client.close()
  })
})
