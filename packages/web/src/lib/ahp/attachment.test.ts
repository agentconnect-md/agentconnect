import { afterEach, describe, expect, it, vi } from 'vitest'
import { AhpClient, InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client'
import { type ActionType, type ChatState, type StateAction, MessageKind } from '@microsoft/agent-host-protocol'
import { AhpAttachment, ahpBrowserTransport } from './attachment'
import { WEBCHAT_CONNECT_FAILED } from '@/lib/webchat-stream'
import { AHP_MAX_MESSAGE_BYTES } from '@agentconnect.md/protocol'

const SESSION = 'ahp-session:/test',
  CHAT = 'ahp-chat:/test'
const empty = () => ({ resource: CHAT, title: 'Chat', status: 1, turns: [] }) as unknown as ChatState
const start: StateAction = {
  type: 'chat/turnStarted' as ActionType.ChatTurnStarted,
  turnId: 'turn',
  startedAt: '2026-10-19T00:00:00Z',
  message: { text: 'Hello', origin: { kind: MessageKind.User } }
}
const opened: AhpAttachment[] = []
afterEach(async () => {
  await Promise.all(opened.map((item) => item.close()))
  opened.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function fixture(snapshot = empty, extensions?: Record<string, unknown>) {
  const received: Array<{ method: string; params: Record<string, unknown> }> = []
  const servers: AhpTransport[] = []
  let clientId = ''
  const attachment = new AhpAttachment(async () => {
    const [client, server] = InMemoryTransport.pair()
    servers.push(server)
    void (async () => {
      while (true) {
        const frame = await server.recv()
        if (!frame || frame.kind !== 'text') return
        const request = JSON.parse(frame.text)
        received.push(request)
        let result: unknown
        if (request.method === 'initialize') {
          clientId = request.params.clientId
          result = { protocolVersion: '1.0.0', serverSeq: 10, snapshots: [], _meta: extensions }
        } else if (request.method === 'subscribe')
          result = {
            snapshot: {
              resource: request.params.channel,
              fromSeq: 10,
              state:
                request.params.channel === CHAT
                  ? snapshot()
                  : {
                      provider: 'agent',
                      title: 'Conversation',
                      status: 1,
                      lifecycle: 'ready',
                      activeClients: [],
                      chats: [{ resource: CHAT }],
                      defaultChat: CHAT
                    }
            }
          }
        if (request.method === 'agentconnect/appRpc') result = { ok: true, result: { value: 'response' } }
        if (request.method === 'agentconnect/appClose') result = null
        if ('id' in request) await server.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      }
    })()
    return client
  })
  opened.push(attachment)
  const action = (action: StateAction, serverSeq: number, rejectionReason?: string, clientSeq?: number) =>
    servers.at(-1)!.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'action',
        params: {
          channel: CHAT,
          action,
          serverSeq,
          origin: clientSeq ? { clientId, clientSeq } : undefined,
          rejectionReason
        }
      })
    )
  return { attachment, received, servers, action }
}
describe('official SDK attachment', () => {
  it('closes after the echo deadline and does not retry an unconfirmed action', async () => {
    const f = fixture()
    await f.attachment.attach(SESSION)
    vi.useFakeTimers()
    const sending = f.attachment.dispatch(start)
    const unknown = expect(sending).rejects.toThrow('could not be confirmed')
    await vi.advanceTimersByTimeAsync(30_001)
    await unknown
    expect(f.attachment.snapshot.connected).toBe(false)
    expect(f.attachment.snapshot.uncertain).toBe(true)
    await f.attachment.attach()
    expect(f.attachment.snapshot.uncertain).toBe(true)
    expect(f.received.filter((frame) => frame.method === 'dispatchAction')).toHaveLength(1)
  })
  it('requires MCP app negotiation and accepts the null close result', async () => {
    const baseline = fixture()
    await baseline.attachment.attach(SESSION)
    await expect(baseline.attachment.closeApp('app')).rejects.toThrow('unavailable')
    const enabled = fixture(empty, { 'agentconnect.md': { mcpApps: true } })
    await enabled.attachment.attach(SESSION)
    await expect(
      enabled.attachment.appRpc('app', 'call', { method: 'resources/read', uri: 'ui://test' })
    ).resolves.toEqual({ ok: true, result: { value: 'response' } })
    await expect(enabled.attachment.closeApp('app')).resolves.toBeUndefined()
    expect(enabled.received.at(-1)).toMatchObject({
      method: 'agentconnect/appClose',
      params: { channel: CHAT, appId: 'app' }
    })
  })
  it.each(['initialize', 'subscribe'] as const)('ignores a retired %s result', async (method) => {
    let release!: () => void,
      reached = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = AhpClient.prototype[method]
    vi.spyOn(AhpClient.prototype, method).mockImplementationOnce(async function (this: AhpClient, ...args: unknown[]) {
      const result = await Reflect.apply(original, this, args)
      reached = true
      await gate
      return result
    })
    const f = fixture(),
      attaching = f.attachment.attach(SESSION)
    await vi.waitFor(() => expect(reached).toBe(true))
    await f.attachment.close()
    release()
    await attaching
    expect(f.attachment.snapshot.connected).toBe(false)
    expect(f.attachment.snapshot.chat).toBeUndefined()
  })
  it('accepts sequence gaps and never applies a rejected action', async () => {
    const f = fixture()
    await f.attachment.attach(SESSION)
    const sending = f.attachment.dispatch(start)
    const refused = expect(sending).rejects.toThrow('Not authorized')
    await vi.waitFor(() => expect(f.received.at(-1)?.method).toBe('dispatchAction'))
    await f.action(start, 25, 'Not authorized', 1)
    await refused
    expect(f.attachment.snapshot.chat?.activeTurn).toBeUndefined()
    await f.action(start, 53)
    await vi.waitFor(() => expect(f.attachment.snapshot.chat?.activeTurn?.id).toBe('turn'))
  })
  it('clears the interruption error once a reconnect attaches', async () => {
    const f = fixture()
    await f.attachment.attach(SESSION)
    await f.servers.at(-1)!.close()
    await vi.waitFor(() => expect(f.attachment.snapshot.error).toMatch('Connection interrupted'))
    await f.attachment.attach()
    expect(f.attachment.snapshot).toEqual(expect.objectContaining({ connected: true, error: undefined }))
  })
  it('does not resend an unknown delivery and reconciles only snapshot evidence', async () => {
    let snapshot = empty()
    const f = fixture(() => snapshot)
    await f.attachment.attach(SESSION)
    const sending = f.attachment.dispatch(start),
      unknown = expect(sending).rejects.toThrow('could not be confirmed')
    await f.servers.at(-1)!.close()
    await unknown
    await f.attachment.attach()
    expect(f.attachment.snapshot.uncertain).toBe(true)
    snapshot = {
      ...empty(),
      activeTurn: {
        id: 'turn',
        startedAt: '2026-10-19T00:00:00Z',
        message: start.message,
        responseParts: [],
        usage: undefined
      }
    } as ChatState
    await f.attachment.attach()
    expect(f.attachment.snapshot.uncertain).toBe(false)
    expect(f.received.filter((frame) => frame.method === 'dispatchAction')).toHaveLength(1)
  })
  it('checks actual serialized frame bytes before consuming a client sequence', async () => {
    const f = fixture()
    await f.attachment.attach(SESSION)
    const fitting = { ...start, message: { ...start.message, text: '' } }
    fitting.message.text = 'a'.repeat(f.attachment.remainingActionBytes(fitting))
    await expect(
      f.attachment.dispatch({ ...fitting, message: { ...fitting.message, text: fitting.message.text + '图' } })
    ).rejects.toThrow('too large')
    const sending = f.attachment.dispatch(fitting)
    await vi.waitFor(() => expect(f.received.at(-1)?.method).toBe('dispatchAction'))
    expect(new TextEncoder().encode(JSON.stringify(f.received.at(-1))).length).toBe(AHP_MAX_MESSAGE_BYTES)
    expect(f.received.at(-1)?.params.clientSeq).toBe(1)
    await f.action(fitting, 11, undefined, 1)
    await sending
  })
  it('closes before SDK queue eviction during a deferred subscribe', async () => {
    let release!: () => void,
      reached = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = AhpClient.prototype.subscribe
    vi.spyOn(AhpClient.prototype, 'subscribe').mockImplementation(async function (this: AhpClient, ...args) {
      const result = await original.apply(this, args)
      if (args[0] === CHAT && !reached) {
        reached = true
        await gate
      }
      return result
    })
    const f = fixture(),
      attaching = f.attachment.attach(SESSION),
      failed = expect(attaching).rejects.toThrow('disconnected')
    await vi.waitFor(() => expect(reached).toBe(true))
    for (let seq = 11; seq < 5011; seq++) await f.action(start, seq)
    release()
    await failed
    expect(f.attachment.snapshot.connected).toBe(false)
    await f.attachment.attach()
    expect(f.attachment.snapshot.connected).toBe(true)
    expect(f.received.filter((frame) => frame.method === 'dispatchAction')).toEqual([])
  })

  it('names the browser connection when the socket never opens', async () => {
    class FailingSocket extends EventTarget {
      constructor() {
        super()
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
      }
    }
    vi.stubGlobal('WebSocket', FailingSocket)
    await expect(ahpBrowserTransport('wss://relay.example.test/ahp', 'token')).rejects.toThrow(WEBCHAT_CONNECT_FAILED)
  })
})
