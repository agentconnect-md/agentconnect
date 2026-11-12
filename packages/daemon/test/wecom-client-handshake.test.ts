import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { WeComClient, type WeComCallback } from '../src/platforms/wecom/client.js'
import { quietLog } from './fakes/wecom-server.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function loopbackServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
  const rawHeaderNames: string[][] = []
  const sockets: WebSocket[] = []
  wss.on('connection', (socket, req) => {
    rawHeaderNames.push(req.rawHeaders.filter((_, i) => i % 2 === 0))
    sockets.push(socket)
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { cmd: string; headers: { req_id: string } }
      if (frame.cmd === 'aibot_subscribe') socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }))
    })
  })
  const { port } = wss.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}`, rawHeaderNames, sockets }
}

describe('WeCom client default socket', () => {
  it('sends Sec-WebSocket-Key in canonical case, subscribes, and receives text frames as strings', async () => {
    const server = await loopbackServer()
    const callbacks: WeComCallback[] = []
    const client = new WeComClient({
      botId: 'aibot-example',
      secret: 'secret-placeholder',
      url: server.url,
      onCallback: (callback) => callbacks.push(callback),
      onKicked: () => undefined,
      log: quietLog
    })
    cleanups.push(() => client.stop())
    await client.start()
    expect(client.connected).toBe(true)
    expect(server.rawHeaderNames).toHaveLength(1)
    expect(server.rawHeaderNames[0]).toContain('Sec-WebSocket-Key')
    server.sockets[0]!.send(
      JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'req-example' }, body: { msgid: 'msg-example' } })
    )
    await vi.waitFor(() => expect(callbacks).toHaveLength(1))
    expect(callbacks[0]).toMatchObject({
      cmd: 'aibot_msg_callback',
      reqId: 'req-example',
      body: { msgid: 'msg-example' }
    })
  })
})
