import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { FormFillEndpoint, FormFillLinkError } from './endpoint.js'

const EXTENSION = 'abcdefghijklmnopabcdefghijklmnop'
const BUILD = 'build-1'

let endpoint: FormFillEndpoint | undefined
afterEach(async () => {
  await endpoint?.close()
  endpoint = undefined
})

// Every connection is attributed to the profile `next.profile`, as /proc would for the browser that opened it.
async function start(next: { profile: string | undefined }) {
  const logs: string[] = []
  endpoint = new FormFillEndpoint({
    port: 0,
    extensionIds: [EXTENSION],
    buildId: BUILD,
    desktopFor: (profile) => ({ '/profiles/main': 'main', '/profiles/d1': 'd1' })[profile],
    attribute: () => (next.profile ? { pid: 42, profile: next.profile } : undefined),
    log: (line) => logs.push(line),
    helloTimeoutMs: 2000
  })
  const port = await endpoint.start()
  return { port, logs }
}

interface Client {
  socket: WebSocket
  messages: unknown[]
  closed: Promise<number>
}

function dial(port: number, origin = `chrome-extension://${EXTENSION}`): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, 'agentconnect.form-fill.v1', { origin })
    const messages: unknown[] = []
    const closed = new Promise<number>((done) => socket.once('close', (code) => done(code)))
    socket.on('message', (data) => messages.push(JSON.parse(String(data))))
    socket.once('open', () => resolve({ socket, messages, closed }))
    socket.once('error', reject)
  })
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

async function hello(client: Client, buildId = BUILD) {
  client.socket.send(JSON.stringify({ type: 'hello', protocol: 1, buildId, version: '2.0.0' }))
}

describe('form fill endpoint (computer-form-fill-and-vault.md §8)', () => {
  it('refuses a web page or any other origin before attribution', async () => {
    const { port } = await start({ profile: '/profiles/main' })
    await expect(dial(port, 'https://evil.example.test')).rejects.toThrow(/403/)
  })

  it('closes a socket that /proc does not attribute to a desktop browser', async () => {
    const { port } = await start({ profile: undefined })
    const client = await dial(port)
    expect(await client.closed).toBe(4401)
    await endpoint!.close()
    const other = await start({ profile: '/profiles/someone-else' })
    expect(await (await dial(other.port)).closed).toBe(4401)
  })

  it('refuses another build of the extension', async () => {
    const { port, logs } = await start({ profile: '/profiles/main' })
    const client = await dial(port)
    await hello(client, 'stale-build')
    expect(await client.closed).toBe(4426)
    expect(logs.join('\n')).toMatch(/restart its browser/)
  })

  it('welcomes the expected build and correlates replies to requests', async () => {
    const { port } = await start({ profile: '/profiles/d1' })
    const client = await dial(port)
    await hello(client)
    await until(() => client.messages.length === 1)
    expect(client.messages[0]).toEqual({ type: 'welcome', protocol: 1 })
    expect(endpoint!.connected('d1')).toBe(true)
    expect(endpoint!.connected('main')).toBe(false)
    client.socket.on('message', (data) => {
      const request = JSON.parse(String(data)) as { type: string; id: number }
      if (request.type === 'discover')
        client.socket.send(JSON.stringify({ type: 'reply', id: request.id, error: 'no tab' }))
    })
    expect(await endpoint!.request('d1', { type: 'discover' }, 2000)).toMatchObject({ type: 'reply', error: 'no tab' })
  })

  it('says nothing was sent when the desktop has no link, and that it may have been when the link drops', async () => {
    const { port } = await start({ profile: '/profiles/main' })
    const missing = await endpoint!.request('main', { type: 'ping' }, 1000).catch((error: FormFillLinkError) => error)
    expect(missing).toBeInstanceOf(FormFillLinkError)
    expect((missing as FormFillLinkError).sent).toBe(false)
    const client = await dial(port)
    await hello(client)
    await until(() => endpoint!.connected('main'))
    const pending = endpoint!.request('main', { type: 'ping' }, 5000).catch((error: FormFillLinkError) => error)
    await until(() => client.messages.length === 2)
    client.socket.close()
    const lost = await pending
    expect(lost).toBeInstanceOf(FormFillLinkError)
    expect((lost as FormFillLinkError).sent).toBe(true)
  })

  it('reports in doctor which browsers are connected, and which run another build, and tells an agent why', async () => {
    const { port } = await start({ profile: '/profiles/d1' })
    expect(endpoint!.check()).toMatchObject({ status: 'info' })
    const stale = await dial(port)
    await hello(stale, 'stale-build')
    expect(await stale.closed).toBe(4426)
    expect(endpoint!.check()).toMatchObject({ status: 'warn', detail: 'another extension build on desktop d1' })
    expect(endpoint!.unavailableReason('d1')).toMatch(/restart the browser/)
    const fresh = await dial(port)
    await hello(fresh)
    await until(() => endpoint!.connected('d1'))
    expect(endpoint!.check()).toEqual({
      name: 'form fill browsers',
      status: 'ok',
      detail: 'extension 2.0.0 connected on desktop d1'
    })
    expect(endpoint!.unavailableReason('d1')).toBe("this desktop's browser extension is not connected")
  })

  it('lets a newer link from the same desktop supersede the older one', async () => {
    const { port } = await start({ profile: '/profiles/main' })
    const first = await dial(port)
    await hello(first)
    await until(() => endpoint!.connected('main'))
    const second = await dial(port)
    await hello(second)
    expect(await first.closed).toBe(4409)
    await until(() => second.messages.length === 1)
    expect(endpoint!.connected('main')).toBe(true)
  })
})
