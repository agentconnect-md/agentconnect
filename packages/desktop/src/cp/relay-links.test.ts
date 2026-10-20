import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  RELAY_COMPUTER_SUBPROTOCOL,
  buildRelayComputerFrame,
  decodeRelayComputerFrame,
  signComputerChannelToken,
  verifyComputerChannelToken,
  type CrHttpResponse,
  type RelayComputerFrame
} from '@agentconnect.md/protocol/computer'
import { Computer } from '../computer.js'
import { issueClientToken } from '../config.js'
import { channelPrincipal, createRelayedMcpHandler } from '../mcp-access.js'
import { FakeDriver, testConfig } from '../testing.js'
import { createComputerMcpServer } from '../tools.js'
import { ChannelAuthority } from './authority.js'
import { RelayLinks } from './relay-links.js'

const COMPUTER = '00000000-0000-4000-8000-000000000001'
const AGENT = '00000000-0000-4000-8000-0000000000bb'
const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const key = randomBytes(32)
const keyId = '1760000000000'

const servers: WebSocketServer[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// A relay's end of the wire: checks the hello token as the CP would, then forwards HTTP bodies to the desktop.
async function fakeRelay(relayId = RELAY_ID) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: () => RELAY_COMPUTER_SUBPROTOCOL })
  servers.push(wss)
  await new Promise((resolve) => wss.once('listening', resolve))
  let desktop: WebSocket | undefined
  const helloTokens: string[] = []
  const pending = new Map<string, (res: CrHttpResponse) => void>()
  const attached = new Promise<void>((resolve) => {
    wss.on('connection', (ws, req) => {
      expect(req.url).toBe('/relay-0/cr/ws')
      ws.on('message', (data: Buffer) => {
        const decoded = decodeRelayComputerFrame(data.toString())
        if (!decoded.ok) return
        const frame: RelayComputerFrame = decoded.frame
        if (frame.type === 'cr/hello') {
          helloTokens.push(frame.payload.token)
          const ok = verifyComputerChannelToken(frame.payload.token, {
            aud: 'relay',
            computerId: COMPUTER,
            key: (kid) => (kid === keyId ? key : undefined),
            now: Date.now()
          })
          ws.send(
            JSON.stringify(
              ok
                ? buildRelayComputerFrame('cr/hello/ok', { relayId }, { corr: frame.id })
                : buildRelayComputerFrame(
                    'error',
                    { code: 'AUTH_FAILED', message: 'no', retryable: true },
                    { corr: frame.id }
                  )
            )
          )
          if (ok) {
            desktop = ws
            resolve()
          }
        }
        if (frame.type === 'cr/http/result' && frame.corr) pending.get(frame.corr)?.(frame.payload)
      })
    })
  })
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/relay-0/rd/ws`
  // An MCP client's fetch, carried over the desktop's link the way the relay's HTTP route does.
  const fetchVia: typeof fetch = async (_input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value))
    const frame = buildRelayComputerFrame('cr/http', {
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
      path: '/mcp',
      headers,
      ...(init?.body ? { body: Buffer.from(String(init.body)).toString('base64') } : {})
    })
    const res = await new Promise<CrHttpResponse>((resolve) => {
      pending.set(frame.id, resolve)
      desktop!.send(JSON.stringify(frame))
    })
    return new Response(res.body ? Buffer.from(res.body, 'base64') : null, { status: res.status, headers: res.headers })
  }
  return { url, attached, helloTokens, fetchVia }
}

function harness() {
  const driver = new FakeDriver()
  const issued = issueClientToken(testConfig({ actionScreenshot: false }), 'owner')
  const computer = new Computer({ driver, config: issued.config })
  const authority = new ChannelAuthority({ registered: true })
  stops.push(() => authority.close())
  authority.syncClock(new Date().toISOString())
  authority.accept({
    keyId,
    key: key.toString('base64url'),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString()
  })
  const links = new RelayLinks({
    computerId: COMPUTER,
    desktopDaemonVersion: '0.1.0',
    token: () => authority.relayToken(COMPUTER),
    handle: createRelayedMcpHandler({
      authenticate: (header) => channelPrincipal(header, authority, () => COMPUTER),
      createMcpServer: ({ client, viewOnly }) => createComputerMcpServer({ computer, client, viewOnly }),
      log: () => undefined
    }),
    log: () => undefined
  })
  stops.push(() => links.stop())
  return { driver, computer, links, localToken: issued.token, authority }
}

// What the CP's grant hands an agent daemon.
const sessionToken = (mode: 'view' | 'control' = 'control', session = 'sess-1') => {
  const now = Date.now()
  return signComputerChannelToken(
    { aud: 'mcp', cmp: COMPUTER, kid: keyId, iat: now, exp: now + 120_000, ses: session, agt: AGENT, mode },
    key
  )
}

async function mcpClient(fetchVia: typeof fetch, token: string): Promise<Client> {
  const client = new Client({ name: 'agent-daemon', version: '0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://relay.invalid/cr/computers/x/mcp'), {
      fetch: fetchVia,
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    })
  )
  return client
}

describe('desktop relay links', () => {
  it('attaches to a roster relay and serves a session token through it as that session', async () => {
    const relay = await fakeRelay()
    const { links, computer, driver } = harness()
    links.converge([{ relayId: RELAY_ID, url: relay.url }])
    await relay.attached
    await expect.poll(() => links.attached()).toEqual([RELAY_ID])

    const client = await mcpClient(relay.fetchVia, sessionToken())
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('computer_click')
    const shot = await client.callTool({ name: 'computer_screenshot', arguments: {} })
    expect((shot.content as { type: string }[])[0]?.type).toBe('image')
    await client.callTool({ name: 'computer_click', arguments: { x: 10, y: 10 } })
    // The lease names the session the CP put in the token, the holder the CP's control lease names too.
    expect(computer.info().lease).toMatchObject({ holder: 'sess-1' })
    expect(driver.inputCalls()).toContain('click')
    await client.close()
  })

  it('offers a view grant only the tools that never send input', async () => {
    const relay = await fakeRelay()
    const { links } = harness()
    links.converge([{ relayId: RELAY_ID, url: relay.url }])
    await relay.attached
    const client = await mcpClient(relay.fetchVia, sessionToken('view'))
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    expect(tools).toContain('computer_screenshot')
    expect(tools).not.toContain('computer_click')
    expect(tools).not.toContain('computer_acquire')
    await client.close()
  })

  it('refuses a local client token, a token for another Computer and a lapsed key over the relay', async () => {
    const relay = await fakeRelay()
    const { links, localToken, authority } = harness()
    links.converge([{ relayId: RELAY_ID, url: relay.url }])
    await relay.attached
    await expect(mcpClient(relay.fetchVia, localToken)).rejects.toThrow()
    const foreign = signComputerChannelToken(
      {
        aud: 'mcp',
        cmp: '00000000-0000-4000-8000-000000000009',
        kid: keyId,
        iat: Date.now(),
        exp: Date.now() + 60_000,
        ses: 's',
        agt: AGENT,
        mode: 'control'
      },
      key
    )
    await expect(mcpClient(relay.fetchVia, foreign)).rejects.toThrow()
    authority.revoke('revoked')
    await expect(mcpClient(relay.fetchVia, sessionToken())).rejects.toThrow()
    expect(authority.relayToken(COMPUTER)).toBeUndefined()
  })

  it('does not attach to an instance that answers with another relay id', async () => {
    const relay = await fakeRelay('22222222-2222-4222-8222-222222222222')
    const { links } = harness()
    links.converge([{ relayId: RELAY_ID, url: relay.url }])
    await relay.attached
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(links.attached()).toEqual([])
    expect(relay.helloTokens.length).toBeGreaterThan(0)
  })
})
