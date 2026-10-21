import { afterEach, describe, expect, it, vi } from 'vitest'
import { DingTalkStream } from '../src/platforms/dingtalk/stream.js'
import { fakeSocketFactory } from './fakes/dingtalk-socket.js'

const log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const streams: DingTalkStream[] = []

afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.stop()
  vi.useRealTimers()
})

function setup(opts: { autoOpen?: boolean } = {}) {
  const factory = fakeSocketFactory(opts)
  const callbacks: { topic: string; data: string }[] = []
  let tickets = 0
  const openConnection = vi.fn(async () => ({
    endpoint: 'wss://stream.example.test/connect',
    ticket: `ticket ${++tickets}`
  }))
  const stream = new DingTalkStream({
    openConnection,
    createSocket: (url) => factory.createSocket(url),
    onCallback: (topic, data) => callbacks.push({ topic, data }),
    log,
    timing: { retireGraceMs: 50, retryBaseMs: 10, retryMaxMs: 20, openTimeoutMs: 200 }
  })
  streams.push(stream)
  return { stream, sockets: factory.sockets, callbacks, openConnection }
}

describe('DingTalk Stream client', () => {
  it('connects with an encoded single-use ticket and acknowledges every frame by messageId', async () => {
    const { stream, sockets, callbacks } = setup()
    await stream.start()
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]!
    expect(socket.url).toBe('wss://stream.example.test/connect?ticket=ticket%201')

    socket.frame({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'ping-1' }, data: '{"opaque":"value"}' })
    socket.callback('cb-1', { msgId: 'm-1' })
    socket.frame({ type: 'EVENT', headers: { topic: 'some/event', messageId: 'ev-1' }, data: '{}' })

    expect(socket.sent).toEqual([
      {
        code: 200,
        headers: { contentType: 'application/json', messageId: 'ping-1' },
        message: 'OK',
        data: '{"opaque":"value"}'
      },
      {
        code: 200,
        headers: { contentType: 'application/json', messageId: 'cb-1' },
        message: 'OK',
        data: JSON.stringify({ response: null })
      },
      {
        code: 200,
        headers: { contentType: 'application/json', messageId: 'ev-1' },
        message: 'OK',
        data: JSON.stringify({ status: 'SUCCESS', message: 'OK' })
      }
    ])
    expect(callbacks).toEqual([{ topic: '/v1.0/im/bot/messages/get', data: JSON.stringify({ msgId: 'm-1' }) }])
  })

  it('opens the replacement before the old socket closes on disconnect, so nothing is lost or reopened', async () => {
    const { stream, sockets, callbacks, openConnection } = setup()
    await stream.start()
    const old = sockets[0]!
    old.frame({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'sys-1' }, data: '{}' })
    await vi.waitFor(() => expect(stream.liveSockets()).toBe(2))
    const replacement = sockets[1]!

    // Both overlap: the old socket still delivers until DingTalk closes it.
    old.callback('cb-old', { msgId: 'during-handover' })
    replacement.callback('cb-new', { msgId: 'after-handover' })
    old.serverClose()
    expect(stream.liveSockets()).toBe(1)
    replacement.callback('cb-new-2', { msgId: 'later' })

    expect(callbacks.map((callback) => JSON.parse(callback.data).msgId)).toEqual([
      'during-handover',
      'after-handover',
      'later'
    ])
    // The old socket's close is the planned end of a handover, not a reason to reconnect.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(openConnection).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)
  })

  it('closes a replaced socket itself when DingTalk does not', async () => {
    const { stream, sockets } = setup()
    await stream.start()
    sockets[0]!.frame({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'sys-1' }, data: '{}' })
    await vi.waitFor(() => expect(stream.liveSockets()).toBe(2))
    await vi.waitFor(() => expect(sockets[0]!.closedByClient).toBe(true))
    expect(stream.liveSockets()).toBe(1)
  })

  it('reconnects with a fresh ticket after an unexpected close', async () => {
    const { stream, sockets, openConnection } = setup()
    await stream.start()
    sockets[0]!.serverClose()
    await vi.waitFor(() => expect(stream.liveSockets()).toBe(1))
    expect(openConnection).toHaveBeenCalledTimes(2)
    expect(sockets[1]!.url).toContain('ticket=ticket%202')
  })

  it('throws from start when the first socket cannot open, and stops cleanly', async () => {
    const { stream, sockets } = setup({ autoOpen: false })
    const started = stream.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.serverClose()
    await expect(started).rejects.toThrow('closed before open')
    await stream.stop()
    expect(stream.liveSockets()).toBe(0)
  })
})
