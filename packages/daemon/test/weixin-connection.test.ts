import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WeixinConnection } from '../src/platforms/weixin/connection.js'

/**
 * End-to-end connection test: a loopback fake of the iLink wire API exercises
 * the vendored SDK through a real WeixinConnection — notifystart, the long
 * poll, inbound normalization, and a sendmessage reply that must carry the
 * peer's context_token back.
 */

interface FakeIlink {
  server: Server
  baseUrl: string
  sent: { envelope: any }[]
  enqueue(msg: object): void
}

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never

async function fakeIlink(): Promise<FakeIlink> {
  const queue: object[] = []
  const wakeups: (() => void)[] = []
  const sent: { envelope: any }[] = []
  const server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const body = await new Promise<string>((ok) => {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => ok(buf))
    })
    if (url.includes('notifystart')) {
      res.end(JSON.stringify({ ret: 0 }))
      return
    }
    if (url.includes('getupdates')) {
      if (!queue.length) {
        // hold the long poll open briefly, like the real gateway
        await Promise.race([new Promise<void>((ok) => wakeups.push(ok)), new Promise<void>((ok) => setTimeout(ok, 50))])
      }
      res.end(JSON.stringify({ ret: 0, msgs: queue.splice(0), get_updates_buf: 'buf-1' }))
      return
    }
    if (url.includes('sendmessage')) {
      sent.push({ envelope: JSON.parse(body) })
      res.end(JSON.stringify({ ret: 0 }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    sent,
    enqueue(msg: object) {
      queue.push(msg)
      wakeups.splice(0).forEach((ok) => ok())
    }
  }
}

const fakes: FakeIlink[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await new Promise((ok) => f.server.close(ok))
})

function connFor(baseUrl: string, onMessage: (m: any) => void): WeixinConnection {
  return new WeixinConnection({ accountId: 'bot-1', botToken: 'tok', baseUrl, integrations: [] }, { log, onMessage })
}

describe('WeixinConnection over a fake iLink server', () => {
  it('polls inbound, normalizes to a DM, and replies with the memorized context_token', async () => {
    const fake = await fakeIlink()
    fakes.push(fake)
    const received: any[] = []
    const conn = connFor(fake.baseUrl, (m) => received.push(m))
    await conn.start()
    try {
      fake.enqueue({
        message_id: 42,
        seq: 7,
        message_type: 1,
        from_user_id: 'peer-9',
        group_id: '',
        item_list: [{ type: 1, text_item: { text: '在吗' } }],
        context_token: 'ctx-abc',
        create_time_ms: 1_700_000_000_000
      })
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000 })
      const msg = received[0]
      expect(msg.platform).toBe('weixin')
      expect(msg.channel).toBe('dm:peer-9')
      expect(msg.text).toBe('在吗')
      expect(msg.isDm).toBe(true)

      await conn.sendText('dm:peer-9', '在的')
      await vi.waitFor(() => expect(fake.sent).toHaveLength(1), { timeout: 3000 })
      const wire = JSON.stringify(fake.sent[0].envelope)
      expect(wire).toContain('ctx-abc')
      expect(wire).toContain('peer-9')
      expect(wire).toContain('在的')
    } finally {
      await conn.stop()
    }
  })

  it('survives an empty group_id on inbound (real iLink DM shape)', async () => {
    const fake = await fakeIlink()
    fakes.push(fake)
    const received: any[] = []
    const conn = connFor(fake.baseUrl, (m) => received.push(m))
    await conn.start()
    try {
      fake.enqueue({
        client_id: 'cli-1',
        message_type: 1,
        from_user_id: 'peer-1',
        group_id: '',
        item_list: [{ type: 1, text_item: { text: 'x' } }]
      })
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000 })
      expect(received[0].channel).toBe('dm:peer-1')
    } finally {
      await conn.stop()
    }
  })
})
