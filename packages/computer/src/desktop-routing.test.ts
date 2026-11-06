import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Computer, ComputerError } from './computer.js'
import { startHttpServer, type RunningHttpServer } from './http-server.js'
import { FakeDriver, testConfig } from './testing.js'
import { createComputerMcpServer } from './tools.js'

let running: RunningHttpServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

// Each caller reaches its own desktop's Computer, resolved per call as the per-agent desktops do (computer-use.md §3.9).
async function start() {
  const config = testConfig({ actionScreenshot: false })
  const make = () => {
    const driver = new FakeDriver()
    return { driver, computer: new Computer({ driver, config }) }
  }
  const desktops = { a: make(), b: make() }
  const main = make()
  const resolved: string[] = []
  running = await startHttpServer({
    host: config.host,
    port: 0,
    computer: main.computer,
    authenticate: (header) => ({ client: header?.replace('Bearer ', '') ?? 'none', viewOnly: false }),
    createMcpServer: ({ client }) =>
      createComputerMcpServer({
        client,
        computer: async () => {
          if (client === 'full') {
            throw new ComputerError('unavailable', 'all 2 desktops of this computer are in use', {
              reason: 'desktops_full'
            })
          }
          resolved.push(client)
          return desktops[client as 'a' | 'b'].computer
        }
      }),
    log: () => undefined
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
  return { desktops, main, resolved, connect }
}

describe('per-agent desktop routing', () => {
  it("sends each caller's input to its own desktop, whose leases do not block each other", async () => {
    const { desktops, main, resolved, connect } = await start()
    const a = await connect('a')
    const b = await connect('b')

    await a.callTool({ name: 'computer_click', arguments: { x: 1, y: 1 } })
    const second = (await b.callTool({ name: 'computer_click', arguments: { x: 2, y: 2 } })) as { isError?: boolean }

    expect(second.isError).toBeFalsy()
    expect(desktops.a.driver.inputCalls()).toContain('click')
    expect(desktops.b.driver.inputCalls()).toContain('click')
    expect(main.driver.inputCalls()).toEqual([])
    expect(desktops.a.computer.leaseActivity()?.holder).toBe('a')
    expect(desktops.b.computer.leaseActivity()?.holder).toBe('b')
    expect(new Set(resolved)).toEqual(new Set(['a', 'b']))
    await a.close()
    await b.close()
  })

  it('tells a caller with no free desktop unavailable/desktops_full, never computer_busy', async () => {
    const { connect } = await start()
    const full = await connect('full')

    const result = (await full.callTool({ name: 'computer_screenshot', arguments: {} })) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'unavailable', reason: 'desktops_full' })
    await full.close()
  })
})
