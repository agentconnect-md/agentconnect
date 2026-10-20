import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_APPROVAL_META_KEY } from '@agentconnect.md/protocol/computer'
import { auditSinks, type AuditRecord } from './audit.js'
import { Computer } from './computer.js'
import { startHttpServer, type RunningHttpServer } from './http-server.js'
import type { McpPrincipal } from './mcp-access.js'
import { FakeDriver, testConfig } from './testing.js'
import { createComputerMcpServer } from './tools.js'
import { createViewer } from './viewer.js'

const AGENT = '00000000-0000-4000-8000-0000000000bb'

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

// Bearer `agent` is an agent session's channel token, anything else a local client token.
async function start() {
  const records: AuditRecord[] = []
  const config = testConfig({ actionScreenshot: false })
  const computer = new Computer({ driver: new FakeDriver(), config, audit: auditSinks((r) => records.push(r)) })
  const principal = (header: string | undefined): McpPrincipal =>
    header === 'Bearer agent'
      ? { client: `${AGENT}/sess-1`, viewOnly: false, agent: { agentId: AGENT, sessionId: 'sess-1' } }
      : { client: 'local', viewOnly: false }
  running = await startHttpServer({
    host: config.host,
    port: 0,
    computer,
    authenticate: principal,
    createMcpServer: ({ client, agent }) => createComputerMcpServer({ computer, client, ...(agent ? { agent } : {}) }),
    log: () => undefined,
    viewer: createViewer({ computer, authenticate: () => undefined, log: () => undefined })
  })
  const connect = async (token: string) => {
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running!.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )
    return client
  }
  return { records, connect }
}

describe('audit call context', () => {
  it('audits an agent session call with its agent, session and approval, and typed text by length', async () => {
    const { records, connect } = await start()
    const client = await connect('agent')
    await client.callTool({
      name: 'computer_type',
      arguments: { text: 'hello' },
      _meta: { [COMPUTER_APPROVAL_META_KEY]: 'allowed_session' }
    })
    expect(records.at(-1)).toMatchObject({
      tool: 'computer_type',
      client: `${AGENT}/sess-1`,
      agentId: AGENT,
      sessionId: 'sess-1',
      approval: 'allowed_session',
      outcome: 'ok'
    })
    await client.callTool({
      name: 'computer_screenshot',
      arguments: {},
      _meta: { [COMPUTER_APPROVAL_META_KEY]: 'nope' }
    })
    expect(records.at(-1)).toMatchObject({ tool: 'computer_screenshot', agentId: AGENT })
    expect(records.at(-1)!.approval).toBeUndefined()
    await client.close()
  })

  it('ignores an approval claim from a local client token', async () => {
    const { records, connect } = await start()
    const client = await connect('local')
    await client.callTool({
      name: 'computer_click',
      arguments: { x: 1, y: 1 },
      _meta: { [COMPUTER_APPROVAL_META_KEY]: 'allowed' }
    })
    expect(records.at(-1)).toMatchObject({ tool: 'computer_click', client: 'local' })
    expect(records.at(-1)).not.toHaveProperty('approval')
    expect(records.at(-1)).not.toHaveProperty('agentId')
    await client.close()
  })
})
