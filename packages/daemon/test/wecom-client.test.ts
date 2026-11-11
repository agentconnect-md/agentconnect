import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WECOM_LONG_CONNECTION_URL,
  WeComClient,
  WeComRequestError,
  WeComTransportError,
  type WeComCallback
} from '../src/platforms/wecom/client.js'
import { FakeWeComServer, quietLog } from './fakes/wecom-server.js'

const SECRET = 'secret-placeholder'
const clients: WeComClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop()
  vi.useRealTimers()
})

function setup(opts: { log?: typeof quietLog } = {}) {
  const server = new FakeWeComServer()
  const callbacks: WeComCallback[] = []
  const onKicked = vi.fn()
  const client = new WeComClient({
    botId: 'aibot-example',
    secret: SECRET,
    createSocket: server.createSocket,
    onCallback: (callback) => callbacks.push(callback),
    onKicked,
    log: opts.log ?? quietLog,
    timing: { retryBaseMs: 1_000, retryMaxMs: 4_000, stableMs: 10_000 }
  })
  clients.push(client)
  return { server, client, callbacks, onKicked }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('WeCom long-connection client', () => {
  it('dials the public endpoint and subscribes with the BotID and Secret', async () => {
    const { server, client } = setup()
    await client.start()
    expect(server.sockets).toHaveLength(1)
    expect(server.last.url).toBe(WECOM_LONG_CONNECTION_URL)
    const [subscribe] = server.last.sent
    expect(subscribe).toMatchObject({ cmd: 'aibot_subscribe', body: { bot_id: 'aibot-example', secret: SECRET } })
    expect(subscribe!.headers.req_id).toMatch(/^aibot_subscribe_/)
    expect(client.connected).toBe(true)
    expect(client.generation).toBe(1)
  })

  it('fails to start on a refused subscribe, closes the socket, and never logs the Secret', async () => {
    const lines: string[] = []
    const capture = { ...quietLog, warn: (line: string) => lines.push(line), info: (line: string) => lines.push(line) }
    const { server, client } = setup({ log: capture })
    server.answers.set('aibot_subscribe', 853000)
    const failure = await client.start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WeComRequestError)
    expect((failure as WeComRequestError).errcode).toBe(853000)
    expect(server.last.closedByClient).toBe(true)
    expect(client.connected).toBe(false)
    expect(lines.join('\n')).not.toContain(SECRET)
  })

  it('pings on the heartbeat and reconnects when pings go unanswered', async () => {
    vi.useFakeTimers()
    const { server, client } = setup()
    await client.start()
    const first = server.last
    await vi.advanceTimersByTimeAsync(30_000)
    expect(first.frames('ping')).toHaveLength(1)
    server.answers.set('ping', 'silent')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.frames('ping')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(first.readyState).toBe(3)
    expect(client.connected).toBe(false)
    server.answers.delete('ping')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.sockets).toHaveLength(2)
    expect(server.last.frames('aibot_subscribe')).toHaveLength(1)
    expect(client.connected).toBe(true)
  })

  it('reconnects with backoff after a drop, and a callback from the old socket cannot be answered on the new one', async () => {
    vi.useFakeTimers()
    const { server, client, callbacks } = setup()
    await client.start()
    server.last.message('req-old', { msgid: 'm-1' })
    expect(callbacks.map((c) => [c.reqId, c.generation])).toEqual([['req-old', 1]])
    server.refuseOpens = 1
    server.last.serverClose()
    // The first retry lands within the 1 s base, the refused open doubles it, and the second succeeds.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.sockets).toHaveLength(2)
    expect(client.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(server.sockets).toHaveLength(3)
    expect(client.connected).toBe(true)
    expect(client.generation).toBe(2)
    const stale = await client.respond('req-old', 1, { msgtype: 'stream' }).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(WeComTransportError)
    expect(server.last.frames('aibot_respond_msg')).toHaveLength(0)
    server.last.message('req-new', { msgid: 'm-2' })
    expect(callbacks.at(-1)).toMatchObject({ reqId: 'req-new', generation: 2 })
  })

  it('stays down after a kick, reports it once, and dials again only when told to', async () => {
    vi.useFakeTimers()
    const { server, client, onKicked } = setup()
    await client.start()
    server.last.kick()
    expect(onKicked).toHaveBeenCalledTimes(1)
    expect(client.kicked).toBe(true)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(server.sockets).toHaveLength(1)
    await client.redial()
    expect(server.sockets).toHaveLength(2)
    expect(server.last.frames('aibot_subscribe')).toHaveLength(1)
    expect(client.connected).toBe(true)
    expect(onKicked).toHaveBeenCalledTimes(1)
  })

  it('sends replies under one req_id one at a time, each after the previous answer', async () => {
    const { server, client } = setup()
    await client.start()
    server.answers.set('aibot_respond_msg', 'silent')
    const first = client.respond('req-1', 1, { n: 1 })
    const second = client.respond('req-1', 1, { n: 2 })
    const other = client.respond('req-2', 1, { n: 3 })
    await flush()
    expect(server.last.frames('aibot_respond_msg').map((f) => f.body)).toEqual([{ n: 1 }, { n: 3 }])
    server.last.reply({ headers: { req_id: 'req-1' }, errcode: 0, errmsg: 'ok' })
    await first
    await flush()
    expect(server.last.frames('aibot_respond_msg').map((f) => f.body)).toEqual([{ n: 1 }, { n: 3 }, { n: 2 }])
    server.last.reply({ headers: { req_id: 'req-1' }, errcode: 40008, errmsg: 'invalid' })
    await expect(second).rejects.toMatchObject({ errcode: 40008 })
    server.last.reply({ headers: { req_id: 'req-2' }, errcode: 0, errmsg: 'ok' })
    await other
  })

  it('sends proactively under a fresh req_id and refuses while disconnected', async () => {
    const { server, client } = setup()
    await expect(client.send({ chatid: 'user-alice' })).rejects.toBeInstanceOf(WeComTransportError)
    await client.start()
    await client.send({ chatid: 'user-alice', chat_type: 1, msgtype: 'markdown', markdown: { content: 'hi' } })
    const [send] = server.last.frames('aibot_send_msg')
    expect(send!.headers.req_id).toMatch(/^aibot_send_msg_/)
    expect(send!.body).toMatchObject({ chatid: 'user-alice', chat_type: 1 })
  })

  it('passes events on, and ignores unparseable frames and unknown commands', async () => {
    const { server, client, callbacks } = setup()
    await client.start()
    server.last.reply({ cmd: 'aibot_future_command', headers: { req_id: 'x' }, body: {} })
    ;(server.last as unknown as { emit(type: string, data: unknown): void }).emit('message', '{not json')
    server.last.event('req-ev', 'enter_chat')
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0]).toMatchObject({ cmd: 'aibot_event_callback', reqId: 'req-ev' })
    expect(client.connected).toBe(true)
  })
})
