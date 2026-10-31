import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { WireError } from '@agentconnect.md/connection'
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
async function fixture(
  mode: AhpMode = 'on',
  preauth?: { deadlineMs: number; maxMessages: number; maxBytes?: number },
  authorizationServer?: string
) {
  const server = createServer()
  let listener: ((frame: RdAhpMessage | RdAhpClose) => void) | undefined
  let lost = () => {}
  const conn = {
    state: 'READY',
    supports: vi.fn(() => true),
    authorizeAhp: vi.fn(async (_payload: unknown, _initial?: boolean) => true),
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
    daemon: () => placement,
    ...(preauth ? { preauth } : {}),
    ...(authorizationServer ? { authorizationServer } : {})
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
it('rejects query secrets and malformed authorization headers before upgrade', async () => {
  const host = await fixture()
  await expect(dial(`${host.url}?token=secret`)).rejects.toThrow('status:400')
  await expect(dial(`${host.url}?tkn=secret`, [], null)).rejects.toThrow('status:400')
  const basic = new WebSocket(host.url, [], { headers: { Authorization: 'Basic c2VjcmV0' } })
  basic.on('error', () => {})
  const status = await new Promise<number | undefined>((resolve) => {
    basic.on('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    basic.on('open', () => resolve(undefined))
  })
  basic.terminate()
  expect(status).toBe(401)
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
  expect(host.verify).toHaveBeenCalledWith('browser-token', AGENT, 'webchat-token', undefined)
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
it('names a failed forward unavailable unless the daemon link reports backpressure', async () => {
  const host = await fixture()
  for (const [error, reason] of [
    [new Error('socket closed'), 'unavailable'],
    [new WireError('OVERLOADED', 'AHP carrier overloaded', true), 'overloaded']
  ] as const) {
    const socket = await dial(host.url)
    host.conn.sendAhp.mockImplementationOnce(() => {
      throw error
    })
    const close = once(socket, 'close')
    socket.send('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}')
    const [code, why] = await close
    expect([code, String(why)]).toEqual([1013, reason])
  }
})

const RESOURCE = (url: string) => url.replace('ws://', 'https://')
async function preauth(url: string, protocols: string[] = ['ahp']) {
  const socket = await dial(url, protocols, null)
  const inbox: any[] = []
  const waiters: Array<() => void> = []
  socket.on('message', (data) => {
    inbox.push(JSON.parse(String(data)))
    waiters.splice(0).forEach((wake) => wake())
  })
  const closed = once(socket, 'close').then(([code]) => code as number)
  const next = async (match: (message: any) => boolean) => {
    for (;;) {
      const found = inbox.find(match)
      if (found) return found
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  let id = 0
  const request = (method: string, params: unknown) => {
    const requestId = ++id
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }))
    return next((message) => message.id === requestId)
  }
  const initialize = () =>
    request('initialize', {
      channel: 'ahp-root://',
      clientId: 'third-party',
      protocolVersions: ['1.0.0'],
      initialSubscriptions: ['ahp-root://', 'ahp-session:/elsewhere']
    })
  return { socket, inbox, closed, next, request, initialize }
}
it('admits a credential-less ahp upgrade only to initialize and advertise the protected endpoint', async () => {
  const host = await fixture()
  const client = await preauth(host.url)
  expect(client.socket.protocol).toBe('ahp')
  const hello = await client.initialize()
  expect(hello.result).toMatchObject({ protocolVersion: '1.0.0', serverSeq: 0 })
  expect(hello.result.snapshots).toEqual([
    {
      resource: 'ahp-root://',
      fromSeq: 0,
      state: {
        agents: [
          expect.objectContaining({
            provider: AGENT,
            protectedResources: [expect.objectContaining({ resource: RESOURCE(host.url) })]
          })
        ]
      }
    }
  ])
  const refused = await client.request('listSessions', { channel: 'ahp-root://' })
  expect(refused.error).toMatchObject({ code: -32007, data: { resources: [{ resource: RESOURCE(host.url) }] } })
  expect((await client.request('ping', { channel: 'ahp-root://' })).result).toEqual({})
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  client.socket.close()
  expect(host.verify).not.toHaveBeenCalled()
  expect(host.conn.authorizeAhp).not.toHaveBeenCalled()
})
it('answers reconnect with NotFound and refuses other requests without closing, ignoring notifications', async () => {
  const host = await fixture()
  const resuming = await preauth(host.url)
  expect((await resuming.request('reconnect', { channel: 'ahp-root://' })).error.code).toBe(-32008)
  expect(
    (await resuming.request('authenticate', { channel: 'ahp-root://', resource: RESOURCE(host.url), token: 'k' })).error
      .code
  ).toBe(-32007)
  await resuming.initialize()
  resuming.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'dispatchAction', params: {} }))
  expect((await resuming.request('reconnect', { channel: 'ahp-root://' })).error.code).toBe(-32007)
  expect((await resuming.initialize()).error.code).toBe(-32007)
  expect(resuming.socket.readyState).toBe(WebSocket.OPEN)
  resuming.socket.close()
  const garbage = await preauth(host.url)
  garbage.socket.send('not json')
  expect(await garbage.closed).toBe(1008)
  expect(host.verify).not.toHaveBeenCalled()
})
it('authenticates a VS Code-shaped client that resumes, pipelines requests and pings before authenticate', async () => {
  const host = await fixture()
  const client = await preauth(host.url, [])
  expect((await client.request('reconnect', { channel: 'ahp-root://', clientId: 'third-party' })).error.code).toBe(
    -32008
  )
  await client.initialize()
  const os = client.request('resolveOperatingSystem', { channel: 'ahp-root://' })
  client.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 'diagnostics', method: 'getNetworkDiagnosticsInfo' }))
  client.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'clientInfoChanged', params: {} }))
  const pong = client.request('ping', { channel: 'ahp-root://' })
  const authenticated = client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    scopes: [],
    token: 'personal-key'
  })
  expect((await os).error.code).toBe(-32007)
  expect((await client.next((message) => message.id === 'diagnostics')).error.code).toBe(-32007)
  expect((await pong).result).toEqual({})
  expect((await authenticated).result).toEqual({})
  expect(host.conn.authorizeAhp).toHaveBeenCalledWith(
    expect.objectContaining({ handshake: { clientId: 'third-party', root: true } }),
    true
  )
  expect(host.conn.sendAhp).not.toHaveBeenCalled()
})
it('bounds the pre-auth window by deadline and message count', async () => {
  const host = await fixture('on', { deadlineMs: 50, maxMessages: 3 })
  const stalled = await preauth(host.url)
  await stalled.initialize()
  expect(await stalled.closed).toBe(4401)
  const chatty = await preauth(host.url)
  for (let i = 0; i < 3; i++)
    chatty.socket.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'reconnect', params: {} }))
  chatty.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'reconnect', params: {} }))
  expect(await chatty.closed).toBe(1008)
  expect(host.verify).not.toHaveBeenCalled()
})
it('authenticates after a restoring client pipelines more than the old sixteen-message bound', async () => {
  const host = await fixture()
  const client = await preauth(host.url, [])
  await client.initialize()
  client.socket.send('{"jsonrpc":"2.0","method":"setClientManagedSettingsPermissions","params":{}}')
  client.socket.send('{"jsonrpc":"2.0","method":"unsubscribe","params":{"channel":"ahp-session:/old"}}')
  const config = { type: 'root/configChanged', config: { values: { setting: 'x'.repeat(4096) } } }
  for (let i = 0; i < 20; i++)
    client.socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'dispatchAction',
        params: { channel: 'ahp-root://', clientSeq: i, action: config }
      })
    )
  expect((await client.request('listSessions', { channel: 'ahp-root://' })).error.code).toBe(-32007)
  const authenticated = await client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'personal-key'
  })
  expect(authenticated.result).toEqual({})
})
it('bounds the pre-auth window by bytes', async () => {
  const host = await fixture('on', { deadlineMs: 1000, maxMessages: 128, maxBytes: 1024 })
  const client = await preauth(host.url, [])
  await client.initialize()
  client.socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'notice', params: { pad: 'x'.repeat(1024) } }))
  expect(await client.closed).toBe(1008)
  expect(host.verify).not.toHaveBeenCalled()
})
it('closes on a bad key or an unadvertised resource without opening a daemon attachment', async () => {
  const host = await fixture()
  host.verify.mockResolvedValueOnce({ ok: false, reason: 'AHP access unavailable' })
  const client = await preauth(host.url)
  await client.initialize()
  const refused = await client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'wrong-key'
  })
  expect(refused.error).toMatchObject({ code: -32007, data: { resources: [{ resource: RESOURCE(host.url) }] } })
  expect(await client.closed).toBe(4401)
  expect(host.verify).toHaveBeenCalledWith('wrong-key', AGENT, 'ahp-client-key', RESOURCE(host.url))
  const elsewhere = await preauth(host.url)
  await elsewhere.initialize()
  const unknown = await elsewhere.request('authenticate', {
    channel: 'ahp-root://',
    resource: 'https://other.example.test/',
    token: 'personal-key'
  })
  expect(unknown.error.code).toBe(-32602)
  expect(await elsewhere.closed).toBe(1008)
  expect(host.verify).toHaveBeenCalledTimes(1)
  expect(host.conn.authorizeAhp).not.toHaveBeenCalled()
})
it('attaches an authenticated client with its handshake, then forwards turns and renews with the pushed key', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const host = await fixture()
  host.conn.authorizeAhp.mockImplementationOnce(async () => {
    host.emit('{"jsonrpc":"2.0","method":"action","params":{"channel":"ahp-root://"}}')
    return true
  })
  const client = await preauth(host.url)
  await client.initialize()
  const authenticated = client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'personal-key'
  })
  client.socket.send('{"jsonrpc":"2.0","id":7,"method":"listSessions","params":{"channel":"ahp-root://"}}')
  expect((await authenticated).result).toEqual({})
  expect(host.conn.authorizeAhp).toHaveBeenCalledWith(
    expect.objectContaining({ handshake: { clientId: 'third-party', root: true } }),
    true
  )
  await client.next((message) => message.method === 'action')
  expect(client.inbox.findIndex((message) => message.method === 'action')).toBeGreaterThan(
    client.inbox.findIndex((message) => message.result && !message.result.protocolVersion)
  )
  await vi.waitFor(() =>
    expect(host.conn.sendAhp).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('listSessions') })
    )
  )
  client.socket.send('{"jsonrpc":"2.0","method":"dispatchAction","params":{}}')
  await vi.waitFor(() =>
    expect(host.conn.sendAhp).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('dispatchAction') })
    )
  )
  host.emit('{"jsonrpc":"2.0","method":"action","params":{"channel":"ahp-chat:/one/main"}}')
  await client.next((message) => message.params?.channel === 'ahp-chat:/one/main')
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.verify).toHaveBeenNthCalledWith(2, 'personal-key', AGENT, 'ahp-client-key', RESOURCE(host.url))
  expect(host.conn.authorizeAhp).toHaveBeenCalledTimes(2)
  expect(host.conn.authorizeAhp).toHaveBeenLastCalledWith(expect.not.objectContaining({ handshake: expect.anything() }))
})
it('refuses in-band authentication on a daemon without handshake support', async () => {
  const host = await fixture()
  host.conn.supports.mockImplementation(((feature: string) => feature !== 'api-ahp-handshake-v1') as () => boolean)
  const client = await preauth(host.url)
  await client.initialize()
  const failed = await client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'personal-key'
  })
  expect(failed.error.code).toBe(-32603)
  expect(await client.closed).toBe(1013)
  expect(host.conn.authorizeAhp).not.toHaveBeenCalled()
})
it('admits an upgrade with no subprotocol, as ahpc and VS Code send, through the same pre-auth bounds', async () => {
  const host = await fixture('on', { deadlineMs: 50, maxMessages: 8 })
  const refused = await preauth(host.url, [])
  expect(refused.socket.protocol).toBe('')
  await refused.initialize()
  expect((await refused.request('createSession', { channel: 'ahp-session:/x' })).error.code).toBe(-32007)
  expect(await refused.closed).toBe(4401)
  const stalled = await preauth(host.url, [])
  await stalled.initialize()
  expect(await stalled.closed).toBe(4401)
  host.conn.authorizeAhp.mockClear()
  const client = await preauth(host.url, [])
  const hello = await client.initialize()
  expect(hello.result.snapshots[0].state.agents[0].protectedResources).toEqual([
    { resource: RESOURCE(host.url), resource_name: 'AgentConnect agent', required: true }
  ])
  const authenticated = await client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'personal-key'
  })
  expect(authenticated.result).toEqual({})
  expect(host.verify).toHaveBeenCalledWith('personal-key', AGENT, 'ahp-client-key', RESOURCE(host.url))
  client.socket.send('{"jsonrpc":"2.0","method":"dispatchAction","params":{"channel":"ahp-chat:/one/main"}}')
  await vi.waitFor(() =>
    expect(host.conn.sendAhp).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('dispatchAction') })
    )
  )
  host.emit('{"jsonrpc":"2.0","method":"action","params":{"channel":"ahp-chat:/one/main"}}')
  await client.next((message) => message.params?.channel === 'ahp-chat:/one/main')
})
it('advertises the authorization server with the ahp scope and verifies its token against the endpoint', async () => {
  const host = await fixture('on', undefined, 'https://auth.example.test')
  const client = await preauth(host.url, [])
  const hello = await client.initialize()
  expect(hello.result.snapshots[0].state.agents[0].protectedResources).toEqual([
    {
      resource: RESOURCE(host.url),
      resource_name: 'AgentConnect agent',
      authorization_servers: ['https://auth.example.test'],
      scopes_supported: ['ahp'],
      required: true
    }
  ])
  host.verify.mockResolvedValueOnce({ ok: false, reason: 'AHP access unavailable' })
  const refused = await client.request('authenticate', {
    channel: 'ahp-root://',
    resource: RESOURCE(host.url),
    token: 'oauth-access-token'
  })
  expect(refused.error.code).toBe(-32007)
  expect(host.verify).toHaveBeenCalledWith('oauth-access-token', AGENT, 'ahp-client-key', RESOURCE(host.url))
  expect(await client.closed).toBe(4401)
})
it('adopts a refreshed token pushed on a bound socket and closes on one for another caller', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const host = await fixture()
  const client = await preauth(host.url)
  await client.initialize()
  const authenticate = (token: string) =>
    client.request('authenticate', { channel: 'ahp-root://', resource: RESOURCE(host.url), token })
  expect((await authenticate('first-token')).result).toEqual({})
  expect((await authenticate('refreshed-token')).result).toEqual({})
  expect(host.verify).toHaveBeenLastCalledWith('refreshed-token', AGENT, 'ahp-client-key', RESOURCE(host.url))
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.verify).toHaveBeenLastCalledWith('refreshed-token', AGENT, 'ahp-client-key', RESOURCE(host.url))
  expect(host.conn.sendAhp).not.toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining('authenticate') })
  )
  host.verify.mockResolvedValueOnce({ ...allow(), userId: 'someone-else' })
  expect((await authenticate('foreign-token')).error.code).toBe(-32007)
  expect(await client.closed).toBe(4401)
})
it('keeps a token refreshed while an older renewal is still verifying', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const host = await fixture()
  const client = await preauth(host.url)
  await client.initialize()
  const authenticate = (token: string) =>
    client.request('authenticate', { channel: 'ahp-root://', resource: RESOURCE(host.url), token })
  expect((await authenticate('old-token')).result).toEqual({})
  let release = (_value: RcVerifyResult) => {}
  host.verify.mockImplementationOnce(() => new Promise<RcVerifyResult>((resolve) => (release = resolve)))
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.verify).toHaveBeenLastCalledWith('old-token', AGENT, 'ahp-client-key', RESOURCE(host.url))
  const refreshed = authenticate('new-token')
  // Let the refreshed `authenticate` reach the relay before the older renewal settles.
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
  release(allow())
  expect((await refreshed).result).toEqual({})
  await vi.advanceTimersByTimeAsync(55_000)
  expect(host.verify).toHaveBeenLastCalledWith('new-token', AGENT, 'ahp-client-key', RESOURCE(host.url))
})
