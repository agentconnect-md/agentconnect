import { networkInterfaces } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Computer } from './computer.js'
import { authenticate, issueClientToken } from './config.js'
import { CONTROL_HEADER, startHttpServer, type RunningHttpServer } from './http-server.js'
import { FakeDriver, testConfig } from './testing.js'
import { createComputerMcpServer, exposedDriverTools } from './tools.js'
import { createViewer } from './viewer.js'

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function start(host?: string) {
  const driver = new FakeDriver()
  const issued = issueClientToken(testConfig({ actionScreenshot: false, ...(host ? { host } : {}) }), 'claude')
  const config = issued.config
  const computer = new Computer({ driver, config })
  const driverTools = exposedDriverTools(await driver.listTools())
  running = await startHttpServer({
    host: config.host,
    port: 0,
    computer,
    authenticate: (header) => {
      const client = authenticate(config, header)
      return client ? { client, viewOnly: false } : undefined
    },
    createMcpServer: ({ client }) => createComputerMcpServer({ computer, client, driverTools }),
    log: () => undefined,
    viewer: createViewer({ computer, authenticate: (header) => authenticate(config, header), log: () => undefined })
  })
  return { driver, computer, token: issued.token, url: running.url }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })
  )
  return client
}

describe('desktop HTTP server', () => {
  it('binds loopback with the default config', async () => {
    const { url } = await start()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(running!.address.address).toBe('127.0.0.1')
  })

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
  it.skipIf(!lanIp)('keeps owner controls on loopback when listening on one specific address', async () => {
    const { computer } = await start(lanIp)
    const port = running!.address.port
    const response = await fetch(`http://127.0.0.1:${port}/control/pause`, {
      method: 'POST',
      headers: { [CONTROL_HEADER]: '1' }
    })
    expect(response.status).toBe(200)
    expect(computer.info().status).toBe('paused')
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })).status).toBe(404)
  })

  it('binds every interface only when the host asks for it', async () => {
    await start('0.0.0.0')
    expect(running!.address.address).toBe('0.0.0.0')
  })

  it('rejects MCP requests without a valid token', async () => {
    const { url } = await start()
    const response = await fetch(url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer nope' } })
    expect(response.status).toBe(401)
  })

  it('serves computer_* and lease-gated cua_* tools to an authenticated client', async () => {
    const { url, token, driver } = await start()
    const client = await connect(url, token)
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining(['computer_screenshot', 'computer_click', 'cua_get_window_state', 'cua_click'])
    )
    expect(names).not.toContain('cua_run_script')
    await client.callTool({ name: 'cua_get_window_state', arguments: { pid: 1, screenshot_out_file: 'C:\\x.png' } })
    expect(driver.calls.find((call) => call.name === 'get_window_state')!.args).toEqual({ pid: 1 })

    const shot = await client.callTool({ name: 'computer_screenshot', arguments: {} })
    expect((shot.content as { type: string }[])[0]!.type).toBe('image')
    await client.callTool({ name: 'computer_click', arguments: { x: 3, y: 4 } })
    expect(driver.calls.find((call) => call.name === 'click')!.args).toEqual({ scope: 'desktop', x: 3, y: 4 })
    const list = await client.callTool({ name: 'computer_list', arguments: {} })
    expect((list.content as { text: string }[])[0]!.text).toContain('"holder": "claude"')
    await client.close()
  })

  it('exposes owner controls only to loopback callers that send the control header', async () => {
    const { url, computer } = await start()
    const base = url.replace(/\/mcp$/, '')
    expect((await fetch(`${base}/control/pause`, { method: 'POST' })).status).toBe(403)
    expect(
      (
        await fetch(`${base}/control/pause`, {
          method: 'POST',
          headers: { [CONTROL_HEADER]: '1', origin: 'http://evil' }
        })
      ).status
    ).toBe(403)
    expect((await fetch(`${base}/control/pause`, { method: 'POST', headers: { [CONTROL_HEADER]: '1' } })).status).toBe(
      200
    )
    expect(computer.info().status).toBe('paused')
  })

  it('serves the viewer page publicly and its API to token holders only', async () => {
    const { url, token, driver, computer } = await start()
    const base = url.replace(/\/mcp$/, '')
    const page = await fetch(`${base}/view`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>AgentConnect Desktop</title>')
    expect((await fetch(`${base}/view/api/status`)).status).toBe(401)

    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
    expect((await post('/view/api/input', { type: 'click', x: 0.5, y: 0.5 })).status).toBe(409)
    expect((await post('/view/api/control', { action: 'take' })).status).toBe(200)
    expect(computer.controlledBy('claude')).toBe(true)
    expect((await post('/view/api/input', { type: 'click', x: 2, y: 0.5 })).status).toBe(400)
    expect((await post('/view/api/input', { type: 'type', text: 'hi' })).status).toBe(200)
    expect(driver.calls.at(-1)).toEqual({ name: 'type_text', args: { scope: 'desktop', text: 'hi' } })

    const frame = await fetch(`${base}/view/api/frame`, { headers: auth })
    expect(frame.headers.get('content-type')).toBe('image/png')
    expect(frame.headers.get('x-frame-width')).toBe('1280')
    expect((await post('/view/api/rtc/offer', {})).status).toBe(503)
    await post('/view/api/control', { action: 'release' })
    expect(computer.info().status).toBe('online')
  })
})
