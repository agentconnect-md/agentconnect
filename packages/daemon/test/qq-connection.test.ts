import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { QQConnection } from '../src/platforms/qq/connection.js'
import type { Logger } from '../src/log.js'
import { buildAttachmentBlocks } from '../src/session/attachment-block.js'

const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger

describe('QQ gateway lifecycle', () => {
  it.each([false, true])(
    'stops token recovery without opening a late gateway (request pending=%s)',
    async (pending) => {
      vi.useFakeTimers()
      let finish!: (token: string) => void
      const token = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finish = resolve
            })
        )
      const request = vi.fn()
      const conn = new QQConnection(
        { appId: '100', appSecret: 'secret', integrations: [] },
        { log, token, api: { request }, onMessage: vi.fn() }
      )
      try {
        await conn.start()
        await vi.advanceTimersByTimeAsync(pending ? 1000 : 0)
        expect(token).toHaveBeenCalledTimes(pending ? 2 : 1)
        await conn.stop()
        if (pending) finish('late token')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(request).not.toHaveBeenCalled()
        expect(token).toHaveBeenCalledTimes(pending ? 2 : 1)
      } finally {
        await conn.stop()
        vi.useRealTimers()
      }
    }
  )

  it('recovers from an initial token failure without another start or reconcile', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    const token = vi.fn().mockRejectedValueOnce(new Error('temporary token failure')).mockResolvedValue('token')
    const ready = vi.fn()
    const conn = new QQConnection(
      { appId: '100', appSecret: 'secret', integrations: [] },
      { log: { ...log, info: ready }, token, api: { request: async <T>() => ({ url }) as T }, onMessage: vi.fn() }
    )
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }))
      socket.on('message', () => {
        socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', user: { id: 'bot' } } }))
      })
    })
    try {
      await conn.start()
      await vi.waitFor(() => expect(ready).toHaveBeenCalledWith('qq: gateway ready'), { timeout: 3000 })
      expect(token).toHaveBeenCalledTimes(2)
    } finally {
      await conn.stop()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('accepts DMs and group mentions, filters ambient messages, resumes, and shuts down', async () => {
    const server = new WebSocketServer({ port: 0 })
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
    const handshakes: { op: number; d: { intents?: number; session_id?: string } }[] = []
    const messages = vi.fn()
    const conn = new QQConnection(
      { appId: '100', appSecret: 'secret', integrations: [] },
      {
        log,
        token: async () => 'token',
        api: { request: async <T>() => ({ url }) as T },
        onMessage: messages
      }
    )
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 5000 } }))
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString())
        if (payload.op !== 2 && payload.op !== 6) return
        handshakes.push(payload)
        socket.send(
          JSON.stringify({
            op: 0,
            t: payload.op === 2 ? 'READY' : 'RESUMED',
            s: 1,
            d: { session_id: 'session', user: { id: 'bot' } }
          })
        )
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'GROUP_AT_MESSAGE_CREATE',
            s: 2,
            d: {
              id: 'group-message',
              content: '<@!100> hello group',
              group_openid: 'group',
              author: { member_openid: 'user' }
            }
          })
        )
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'C2C_MESSAGE_CREATE',
            s: 3,
            d: { id: 'message', content: 'hello', author: { user_openid: 'user' }, timestamp: new Date().toISOString() }
          })
        )
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'C2C_MESSAGE_CREATE',
            s: 4,
            d: {
              id: 'image-message',
              content: '',
              author: { user_openid: 'user' },
              timestamp: new Date().toISOString(),
              attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/image', filename: 'test.png' }]
            }
          })
        )
        socket.send(
          JSON.stringify({
            op: 0,
            t: 'GROUP_MESSAGE_CREATE',
            s: 5,
            d: { id: 'ambient', content: '!cancel', group_openid: 'group', author: { member_openid: 'user' } }
          })
        )
      })
    })
    try {
      await conn.start()
      await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(3))
      expect(handshakes[0]).toMatchObject({ op: 2, d: { intents: 1 << 25 } })
      expect(messages.mock.calls[0]![0]).toMatchObject({
        channel: 'group:group',
        thread: 'group',
        text: 'hello group',
        isDm: false,
        mentionedBots: ['100']
      })
      expect(messages.mock.calls[1]![0]).toMatchObject({
        platform: 'qq',
        channel: 'dm:user',
        thread: 'dm',
        text: 'hello'
      })
      const imageMessage = messages.mock.calls[2]![0]
      expect(imageMessage).toMatchObject({ text: '', attachments: [{ name: 'test.png', mimeType: 'image/png' }] })
      const unavailable = await buildAttachmentBlocks(imageMessage.attachments, {
        download: async () => null,
        supports: () => true
      })
      expect(unavailable).toEqual([{ type: 'text', text: expect.stringContaining('QQ image unavailable') }])
      expect(await conn.getChannelInfo('group:group')).toMatchObject({ isIm: false, name: 'QQ group · group' })
      expect(await conn.getChannelInfo('dm:user')).toMatchObject({ isIm: true, name: 'QQ user · user' })
      expect(await conn.getUserProfile('qq:user:100:user')).toEqual({
        id: 'qq:user:100:user',
        avatarUrl: 'https://q.qlogo.cn/qqapp/100/user/640'
      })
      expect(await conn.getUserProfile('qq:user:200:user')).toEqual({ id: 'qq:user:200:user' })
      // QQ may omit names, so two rooms are told apart by their OpenID tails.
      expect((await conn.getChannelInfo('group:7A1B2C3D4E5F60718293A4B5C6D7E8F9')).name).toBe('QQ group · C6D7E8F9')
      expect(await conn.listChannels()).toEqual([
        { id: 'group:group', isPrivate: true },
        { id: 'dm:user', isPrivate: true }
      ])
      for (const socket of server.clients) socket.send(JSON.stringify({ op: 7 }))
      await vi.waitFor(() => expect(handshakes[1]).toMatchObject({ op: 6, d: { session_id: 'session' } }), {
        timeout: 5000
      })
    } finally {
      await conn.stop()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('does not block shutdown on pending gateway discovery', async () => {
    let finish!: (value: { url: string }) => void
    const requested = vi.fn(
      () =>
        new Promise<{ url: string }>((resolve) => {
          finish = resolve
        })
    )
    const conn = new QQConnection(
      { appId: '100', appSecret: 'secret', integrations: [] },
      {
        log,
        token: async () => 'token',
        api: { request: requested as any },
        onMessage: vi.fn()
      }
    )
    await conn.start()
    await vi.waitFor(() => expect(requested).toHaveBeenCalled())
    await conn.stop()
    finish({ url: 'ws://127.0.0.1:1' })
  })
})
