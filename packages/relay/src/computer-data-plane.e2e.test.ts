import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { signComputerChannelToken, type ComputerChannelGrantResult } from '@agentconnect.md/protocol'
// The data plane end to end: the agent daemon's MCP client, this relay, and the desktop daemon's relayed MCP server.
import { connectComputerMcp, type ComputerMcpConnection } from '../../daemon/src/computer/data-plane.js'
import { Computer } from '../../desktop/src/computer.js'
import { ChannelAuthority } from '../../desktop/src/cp/authority.js'
import { RelayLinks } from '../../desktop/src/cp/relay-links.js'
import { channelPrincipal, createRelayedMcpHandler } from '../../desktop/src/mcp-access.js'
import { FakeDriver, testConfig } from '../../desktop/src/testing.js'
import { createComputerMcpServer } from '../../desktop/src/tools.js'
import { createComputerRelay } from './computer-relay.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-0000000000bb'
const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function stack() {
  const app: FastifyInstance = Fastify()
  cleanups.push(() => app.close())
  const relay = createComputerRelay(app, {
    verify: async (_token, computerId) => ({ ok: true, computerId }),
    relayId: () => RELAY_ID,
    log: quiet
  })
  const base = await app.listen({ port: 0, host: '127.0.0.1' })
  const entry = { relayId: RELAY_ID, url: `${base.replace(/^http/, 'ws')}/rd/ws` }

  // The desktop daemon: the channel key the CP sent it, and its links to the roster's relays.
  const key = randomBytes(32)
  const keyId = '1760000000000'
  const authority = new ChannelAuthority({ registered: true })
  cleanups.push(() => authority.close())
  authority.syncClock(new Date().toISOString())
  authority.accept({
    keyId,
    key: key.toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString()
  })
  const driver = new FakeDriver()
  const computer = new Computer({ driver, config: testConfig({ actionScreenshot: false }) })
  const links = new RelayLinks({
    computerId: COMPUTER,
    desktopDaemonVersion: '0.1.0',
    token: () => authority.relayToken(COMPUTER),
    handle: createRelayedMcpHandler({
      authenticate: (header) => channelPrincipal(header, authority, () => COMPUTER),
      createMcpServer: (principal) => createComputerMcpServer({ computer, ...principal }),
      log: () => undefined
    }),
    log: () => undefined
  })
  cleanups.push(() => links.stop())
  links.converge([entry])
  await expect.poll(() => relay.attached(COMPUTER)).toBe(true)

  // What the CP's grant hands the agent daemon.
  const grants = {
    computerChannelGrant: async (): Promise<ComputerChannelGrantResult> => {
      const now = Date.now()
      const exp = now + 120_000
      const token = signComputerChannelToken(
        { aud: 'mcp', cmp: COMPUTER, kid: keyId, iat: now, exp, ses: 'sess-1', agt: AGENT, mode: 'control' },
        key
      )
      return { granted: true, token, expiresAt: new Date(exp).toISOString(), mode: 'control', relays: [entry] }
    }
  }
  const connect = async (): Promise<ComputerMcpConnection> => {
    const connection = await connectComputerMcp({
      grants,
      target: { computerId: COMPUTER, agentId: AGENT, sessionId: 'sess-1' }
    })
    cleanups.push(() => connection.close())
    return connection
  }
  return { relay, driver, connect }
}

describe('computer data plane, agent daemon to desktop through the relay', () => {
  it('lists tools and calls one, and leaves nothing in flight on the relay', async () => {
    const { relay, driver, connect } = await stack()
    const { client } = await connect()
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('computer_click')
    const result = await client.callTool({ name: 'computer_click', arguments: { x: 10, y: 10 } })
    expect(result.isError).toBeFalsy()
    expect(driver.inputCalls()).toContain('click')
    // The client's standalone-stream GET must not hold a relay slot until it times out.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(relay.inFlight(COMPUTER)).toBe(0)
  })

  it('keeps serving past the per-desktop in-flight cap of session connects', async () => {
    const { relay, connect } = await stack()
    for (let i = 0; i < 20; i++) await connect()
    const { client } = await connect()
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    expect(relay.inFlight(COMPUTER)).toBe(0)
  })
})
