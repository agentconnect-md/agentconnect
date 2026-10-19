import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import type { AhpMode, RcVerifyResult, RdAhpClose, RdAhpMessage } from '@agentconnect.md/protocol'
import { createAhpServer } from './ahp-server.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const DAEMON = '22222222-2222-4222-8222-222222222222'
const resources: { server: Server; edge: ReturnType<typeof createAhpServer> }[] = []
afterEach(async () => {
  for (const { server, edge } of resources.splice(0)) {
    for (const ws of edge.wss.clients) ws.terminate()
    edge.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  vi.useRealTimers()
})
const allow = (): RcVerifyResult => ({
  ok: true,
  orgId: 'organization',
  agentId: AGENT,
  daemonId: DAEMON,
  userId: 'user',
  user: 'User',
  callerRole: 'owner',
  callerApproves: true,
  apiProtocols: ['ahp'],
  ahpGrant: { token: 'signed-grant', expiresAtMs: Date.now() + 60_000 }
})
async function fixture(mode: AhpMode = 'on') {
  const server = createServer()
  let listener: ((frame: RdAhpMessage | RdAhpClose) => void) | undefined
  let lost = () => {}
  const conn = {
    state: 'READY',
    supports: vi.fn(() => true),
    authorizeAhp: vi.fn(async () => true),
    sendAhp: vi.fn(),
    listenAhp: (_id: string, next: typeof listener) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    onceClosed: (next: () => void) => {
      lost = next
      return () => {
        lost = () => {}
      }
    }
  }
  const verify = vi.fn(async () => allow())
  let placement = conn as unknown as RelayDaemonConnection
  const edge = createAhpServer({ server } as Parameters<typeof createAhpServer>[0], {
    mode: () => mode,
    verify,
    daemon: () => placement
  })
  resources.push({ server, edge })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ahp/agents/${AGENT}`,
    conn,
    verify,
    edge,
    replace: () => {
      placement = { ...conn } as unknown as RelayDaemonConnection
    },
    lose: () => lost(),
    emit: (message: string) => listener?.({ attachmentId: AGENT, message })
  }
}
async function dial(url: string, protocols: string[] = ['ahp'], token: string | null = 'personal-key') {
  const socket = new WebSocket(url, protocols, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  socket.on('error', () => {})
  socket.on('unexpected-response', (_request, response) => {
    response.resume()
    socket.emit('error', new Error(`status:${response.statusCode}`))
    socket.terminate()
  })
  await once(socket, 'open')
  return socket
}

it.each(['off', 'shadow'] as const)('refuses %s before credential or daemon access', async (mode) => {
  const host = await fixture(mode)
  await expect(dial(host.url)).rejects.toThrow('status:503')
  expect(host.verify).not.toHaveBeenCalled()
  expect(host.conn.authorizeAhp).not.toHaveBeenCalled()
})
it('requires header credentials and rejects query secrets', async () => {
  const host = await fixture()
  await expect(dial(host.url, [], null)).rejects.toThrow('status:401')
  await expect(dial(`${host.url}?token=secret`)).rejects.toThrow('status:400')
  expect(host.verify).not.toHaveBeenCalled()
})
it('refuses disabled API entries, invalid grant lifetimes and a capability lost during open', async () => {
  const host = await fixture()
  for (const verdict of [
    { ...allow(), apiProtocols: [] },
    { ...allow(), ahpGrant: { token: 'expired', expiresAtMs: Date.now() - 1 } },
    { ...allow(), ahpGrant: { token: 'too-long', expiresAtMs: Date.now() + 120_000 } }
  ]) {
    host.verify.mockResolvedValueOnce(verdict)
    await expect(dial(host.url)).rejects.toThrow('status:401')
  }
  expect(host.conn.authorizeAhp).not.toHaveBeenCalled()
  host.conn.authorizeAhp.mockImplementationOnce(async () => {
    host.conn.supports.mockReturnValue(false)
    return true
  })
  await expect(dial(host.url)).rejects.toThrow('status:503')
  expect(host.conn.sendAhp).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unavailable' }))
})
it('renews authority without accepting a different principal and rejects binary content', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const host = await fixture()
  const socket = await dial(host.url)
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.conn.authorizeAhp).toHaveBeenCalledTimes(2)
  host.verify.mockResolvedValueOnce({ ...allow(), userId: 'another-user' })
  const close = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(55_000)
  expect((await close)[0]).toBe(4401)
  expect(host.conn.authorizeAhp).toHaveBeenCalledTimes(2)
  const next = await dial(host.url)
  const binaryClose = once(next, 'close')
  next.send(Buffer.from('{}'))
  expect((await binaryClose)[0]).toBe(1008)
})
it('selects only static ahp and forwards opaque frames with a conversation-bound browser token', async () => {
  const host = await fixture()
  host.verify.mockImplementation(async () => ({ ...allow(), conversationId: '44444444-4444-4444-8444-444444444444' }))
  const socket = await dial(
    host.url,
    ['ahp', `agentconnect.ahp-token.${Buffer.from('browser-token').toString('base64url')}`],
    null
  )
  expect(socket.protocol).toBe('ahp')
  expect(host.verify).toHaveBeenCalledWith('browser-token', AGENT, 'webchat-token')
  socket.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}')
  await vi.waitFor(() =>
    expect(host.conn.sendAhp).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('initialize') })
    )
  )
  const reply = once(socket, 'message')
  host.emit('{"jsonrpc":"2.0","id":1,"result":{}}')
  expect(String((await reply)[0])).toContain('result')
})
it('cleans up lost open receipts and refuses a placement changed during the await', async () => {
  const host = await fixture()
  host.conn.authorizeAhp.mockRejectedValueOnce(new Error('lost receipt'))
  await expect(dial(host.url)).rejects.toThrow('status:503')
  expect(host.conn.sendAhp).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unavailable' }))
  host.conn.authorizeAhp.mockImplementationOnce(async () => {
    host.replace()
    return true
  })
  await expect(dial(host.url)).rejects.toThrow('status:503')
})
it('renews once before expiry and closes independently when CP renewal hangs', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const host = await fixture()
  const socket = await dial(host.url)
  host.verify.mockImplementationOnce(() => new Promise(() => {}))
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.verify).toHaveBeenCalledTimes(2)
  const close = once(socket, 'close')
  await vi.advanceTimersByTimeAsync(5000)
  expect((await close)[0]).toBe(4401)
  expect(host.verify).toHaveBeenCalledTimes(2)
  expect(host.conn.sendAhp).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unauthorized' }))
})
it('closes on daemon hop loss without requesting execution cancellation', async () => {
  const host = await fixture()
  const socket = await dial(host.url)
  const close = once(socket, 'close')
  host.lose()
  expect((await close)[0]).toBe(1013)
  expect(host.conn.sendAhp).not.toHaveBeenCalled()
})
