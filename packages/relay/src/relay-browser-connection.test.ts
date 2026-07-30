import { describe, it, expect, vi } from 'vitest'
import type { RdAck, RdMsgWebchat, WebchatMcpDelegationReference } from '@agentconnect.md/protocol'
import type { ServerTransport } from '@agentconnect.md/connection'
import { RelayBrowserConnection, parseBrowserFrame } from './relay-browser-connection.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const USER = 'ada@example.com'
const DELEGATION: WebchatMcpDelegationReference = {
  id: '33333333-3333-4333-8333-333333333333',
  generation: 7,
  expiresAt: '2026-07-31T12:00:00.000Z'
}
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

class FakeBrowserTransport implements ServerTransport {
  readonly subprotocol = ''
  readonly remoteAddr = 'test'
  sent: Array<Record<string, unknown>> = []
  private msgCb?: (t: string) => void
  private closeCb?: (c: number, r: string) => void
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>)
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.closeCb = cb
  }
  close(): void {}
  feed(obj: unknown): void {
    this.msgCb?.(typeof obj === 'string' ? obj : JSON.stringify(obj))
  }
  fireClose(): void {
    this.closeCb?.(1000, 'gone')
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((f) => f.type === type)
  }
}

function build(
  over: {
    daemon?: RelayDaemonConnection | undefined
    ack?: RdAck
    delegation?: WebchatMcpDelegationReference
    log?: Logger
  } = {}
) {
  const sent: RdMsgWebchat[] = []
  const sendMsg = vi.fn(async (m: RdMsgWebchat): Promise<RdAck> => {
    sent.push(m)
    return over.ack ?? { msgId: m.msgId, accepted: true }
  })
  const daemon = 'daemon' in over ? over.daemon : ({ sendMsg } as unknown as RelayDaemonConnection)
  const register = vi.fn()
  const unregister = vi.fn()
  const transport = new FakeBrowserTransport()
  const conn = new RelayBrowserConnection(transport, {
    chatId: CHAT,
    agentId: AGENT,
    user: USER,
    ...(over.delegation ? { delegation: over.delegation } : {}),
    daemonConn: () => daemon,
    register,
    unregister,
    log: over.log ?? silentLog
  })
  conn.start()
  return { conn, transport, sendMsg, sent, register, unregister }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('parseBrowserFrame', () => {
  it('maps a bare {text} and {type:"message",text} to a turn op carrying the user', () => {
    expect(parseBrowserFrame({ text: 'hi' }, USER)).toEqual({ op: 'turn', text: 'hi', user: USER })
    expect(parseBrowserFrame({ type: 'message', text: 'hi', turnId: AGENT }, USER)).toEqual({
      op: 'turn',
      text: 'hi',
      user: USER,
      turnId: AGENT
    })
  })
  it('carries staged runtime choices on the first turn', () => {
    const runtime = { model: 'gpt-5.6-sol', effort: 'xhigh', permissionMode: 'full-access', fastMode: true }
    expect(parseBrowserFrame({ text: 'hi', runtime }, USER)).toEqual({
      op: 'turn',
      text: 'hi',
      user: USER,
      runtime
    })
    expect(parseBrowserFrame({ text: 'hi', runtime: { fastMode: 'yes' } }, USER)).toBeNull()
  })
  it('maps a bounded image attachment while keeping the verified user authoritative', () => {
    const attachment = {
      name: 'screen.webp',
      mimeType: 'image/webp',
      data: Buffer.from('image').toString('base64')
    }
    expect(parseBrowserFrame({ text: '', user: 'spoofed', attachments: [attachment] }, USER)).toEqual({
      op: 'turn',
      text: '',
      user: USER,
      attachments: [attachment]
    })
    expect(parseBrowserFrame({ text: '', attachments: [{ ...attachment, data: 'invalid' }] }, USER)).toBeNull()
  })
  it('maps the session-control envelopes', () => {
    expect(parseBrowserFrame({ type: 'resume', turnId: AGENT, generation: 3, afterIndex: 4 }, USER)).toEqual({
      op: 'resume',
      turnId: AGENT,
      generation: 3,
      afterIndex: 4
    })
    expect(parseBrowserFrame({ type: 'set_model', model: 'claude' }, USER)).toEqual({
      op: 'set_model',
      model: 'claude'
    })
    expect(parseBrowserFrame({ type: 'set_effort', effort: 'high' }, USER)).toEqual({
      op: 'set_effort',
      effort: 'high'
    })
    expect(parseBrowserFrame({ type: 'set_permission_mode', permissionMode: 'plan' }, USER)).toEqual({
      op: 'set_permission_mode',
      permissionMode: 'plan'
    })
    expect(parseBrowserFrame({ type: 'set_fast', fastMode: true }, USER)).toEqual({ op: 'set_fast', fastMode: true })
    expect(parseBrowserFrame({ type: 'cancel' }, USER)).toEqual({ op: 'cancel' })
  })
  it('rejects malformed / unknown envelopes', () => {
    expect(parseBrowserFrame({ type: 'set_model' }, USER)).toBeNull() // no model
    expect(parseBrowserFrame({ type: 'set_fast', fastMode: 'yes' }, USER)).toBeNull() // wrong type
    expect(parseBrowserFrame({ type: 'resume', turnId: AGENT, generation: 1, afterIndex: -2 }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'resume', turnId: AGENT, generation: 1, afterIndex: 1.5 }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'resume', turnId: AGENT, generation: 0, afterIndex: 0 }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'resume', generation: 1, afterIndex: 0 }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'nope' }, USER)).toBeNull()
    expect(parseBrowserFrame(null, USER)).toBeNull()
    expect(parseBrowserFrame(42, USER)).toBeNull()
  })
})

describe('RelayBrowserConnection', () => {
  it('registers and greets the browser with a ready frame on start', () => {
    const { transport, register } = build()
    expect(register).toHaveBeenCalledWith(CHAT, expect.any(RelayBrowserConnection))
    expect(transport.last('ready')).toEqual({ type: 'ready', conversationId: CHAT, agentId: AGENT })
  })

  it('bridges a {text} turn to an rd/msg(turn) and forwards the daemon ack', async () => {
    const { transport, sent } = build({ ack: { msgId: 'x', accepted: true } })
    transport.feed({ text: 'hello there' })
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      source: 'webchat',
      agentId: AGENT,
      chatId: CHAT,
      sessionKey: CHAT,
      payload: { op: 'turn', text: 'hello there', user: USER }
    })
    expect(transport.last('ack')).toEqual({ type: 'ack', ack: { accepted: true } })
  })

  it('copies the verified delegation reference to every webchat operation', async () => {
    const { transport, sent } = build({ delegation: DELEGATION })
    const operations = [
      { text: 'hello there' },
      { type: 'resume', turnId: AGENT, generation: 4, afterIndex: 7 },
      { type: 'set_model', model: 'claude' },
      { type: 'set_effort', effort: 'high' },
      { type: 'set_permission_mode', permissionMode: 'plan' },
      { type: 'set_fast', fastMode: true },
      { type: 'cancel' }
    ]

    for (const operation of operations) transport.feed(operation)
    transport.fireClose()
    await tick()

    expect(sent).toHaveLength(operations.length + 1)
    expect(sent.map(({ delegation }) => delegation)).toEqual(
      Array.from({ length: operations.length + 1 }, () => DELEGATION)
    )
    expect(sent.at(-1)?.payload).toEqual({ op: 'close' })
  })

  it('keeps legacy browser connections delegation-free', async () => {
    const { transport, sent } = build()
    transport.feed({ text: 'ordinary webchat' })
    transport.fireClose()
    await tick()

    expect(sent).toHaveLength(2)
    expect(sent.every((message) => message.delegation === undefined)).toBe(true)
  })

  it('does not parse browser delegation fields at any nesting depth', () => {
    const forged = {
      id: '44444444-4444-4444-8444-444444444444',
      generation: 999,
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    const parsed = parseBrowserFrame(
      {
        type: 'message',
        text: 'try to escape',
        delegation: forged,
        payload: { delegation: forged },
        runtime: { model: 'claude', delegation: forged }
      },
      USER
    )

    expect(parsed).toEqual({ op: 'turn', text: 'try to escape', user: USER, runtime: { model: 'claude' } })
    expect(parsed).not.toHaveProperty('delegation')
    expect(parsed).not.toHaveProperty('payload')
    expect(parsed).not.toHaveProperty('runtime.delegation')
  })

  it('bridges an image-only turn without putting the bytes on any control-plane path', async () => {
    const { transport, sent } = build()
    const attachment = {
      name: 'screen.webp',
      mimeType: 'image/webp',
      data: Buffer.from('image').toString('base64')
    }
    transport.feed({ attachments: [attachment] })
    await tick()
    expect(sent[0]).toMatchObject({
      source: 'webchat',
      payload: { op: 'turn', text: '', user: USER, attachments: [attachment] }
    })
  })

  it('surfaces a rejected turn ack with its reason', async () => {
    const { transport } = build({ ack: { msgId: 'x', accepted: false, reason: 'paused' } })
    transport.feed({ text: 'hi' })
    await tick()
    expect(transport.last('ack')).toEqual({ type: 'ack', ack: { accepted: false, reason: 'paused' } })
  })

  it('forwards a resume cursor and surfaces its replay verdict', async () => {
    const turnId = '22222222-2222-4222-8222-222222222222'
    const { transport, sent } = build({ ack: { msgId: 'resume-1', accepted: true, turnId } })
    transport.feed({ type: 'resume', turnId, generation: 4, afterIndex: 7 })
    await tick()
    expect(sent[0]).toMatchObject({ payload: { op: 'resume', turnId, generation: 4, afterIndex: 7 } })
    expect(transport.last('resumed')).toEqual({
      type: 'resumed',
      ack: { accepted: true, turnId }
    })
  })

  it('translates an rd/chat output/done back to {type:output}/{type:done}', () => {
    const { conn, transport } = build()
    const outputPayload = { conversationId: CHAT, turnId: AGENT, index: 0, status: { model: 'claude' } }
    const donePayload = { conversationId: CHAT, turnId: AGENT }
    conn.onChat({ chatId: CHAT, seq: 0, event: { kind: 'output', output: outputPayload } })
    conn.onChat({ chatId: CHAT, seq: 1, event: { kind: 'done', done: donePayload } })
    expect(transport.last('output')).toEqual({ type: 'output', output: outputPayload })
    expect(transport.last('done')).toEqual({ type: 'done', done: donePayload })
  })

  it('forwards a session-control op WITHOUT sending an ack (only turns are acked)', async () => {
    const { transport, sent } = build()
    transport.feed({ type: 'set_model', model: 'claude' })
    await tick()
    expect(sent[0]).toMatchObject({ payload: { op: 'set_model', model: 'claude' } })
    expect(transport.last('ack')).toBeUndefined()
  })

  it('answers an error frame when the agent daemon is offline (no rd/msg attempted)', async () => {
    const { transport, sendMsg } = build({ daemon: undefined })
    transport.feed({ text: 'hi' })
    await tick()
    expect(sendMsg).not.toHaveBeenCalled() // daemonConn() → undefined ⇒ never bridged
    expect(transport.last('error')).toEqual({ type: 'error', message: 'agent daemon offline' })
  })

  it('answers an error frame on an unparseable or unrecognized envelope', async () => {
    const { transport } = build()
    transport.feed('}{ not json')
    expect(transport.last('error')).toEqual({ type: 'error', message: 'invalid frame' })
    transport.feed({ type: 'wat' })
    expect(transport.last('error')).toEqual({ type: 'error', message: 'unrecognized frame' })
  })

  it('answers an error frame when rd/msg delivery rejects', async () => {
    const sendMsg = vi.fn(async () => {
      throw new Error('ack timeout')
    })
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const transport = new FakeBrowserTransport()
    new RelayBrowserConnection(transport, {
      chatId: CHAT,
      agentId: AGENT,
      user: USER,
      daemonConn: () => daemon,
      register: vi.fn(),
      unregister: vi.fn(),
      log: silentLog
    }).start()
    transport.feed({ text: 'hi' })
    await tick()
    expect(transport.last('error')).toEqual({ type: 'error', message: 'delivery failed' })
  })

  it('does not disclose a delegation reference through delivery logs or browser errors', async () => {
    const warnings: string[] = []
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {}
    }
    const sendMsg = vi.fn(async () => {
      throw new Error(`failed frame ${JSON.stringify(DELEGATION)}`)
    })
    const { transport } = build({
      daemon: { sendMsg } as unknown as RelayDaemonConnection,
      delegation: DELEGATION,
      log
    })

    transport.feed({ text: 'hi' })
    await tick()

    expect(warnings.join('\n')).not.toContain(DELEGATION.id)
    expect(JSON.stringify(transport.last('error'))).not.toContain(DELEGATION.id)
  })

  it('treats browser close as transport observability while an accepted turn keeps completing', async () => {
    let completeTurn!: (value: RdAck) => void
    const delivered: RdMsgWebchat[] = []
    const sendMsg = vi.fn((message: RdMsgWebchat) => {
      delivered.push(message)
      return message.payload.op === 'turn'
        ? new Promise<RdAck>((resolve) => {
            completeTurn = resolve
          })
        : Promise.resolve({ msgId: message.msgId, accepted: true })
    })
    const { transport } = build({
      daemon: { sendMsg } as unknown as RelayDaemonConnection,
      delegation: DELEGATION
    })

    transport.feed({ text: 'long turn' })
    await tick()
    transport.fireClose()
    await tick()
    completeTurn({ msgId: delivered[0]!.msgId, accepted: true })
    await tick()

    expect(delivered.map(({ payload }) => payload.op)).toEqual(['turn', 'close'])
    expect(delivered[0]?.delegation).toEqual(DELEGATION)
    expect(delivered[1]?.delegation).toEqual(DELEGATION)
    expect(transport.last('ack')).toBeUndefined()
  })

  it('on close: unregisters and forwards a best-effort {op:close} to the daemon', async () => {
    const { transport, sent, unregister } = build()
    transport.fireClose()
    await tick()
    expect(unregister).toHaveBeenCalledWith(CHAT, expect.any(RelayBrowserConnection))
    expect(sent.at(-1)).toMatchObject({ payload: { op: 'close' }, chatId: CHAT })
  })

  it('goes silent after close — a late rd/chat is not written to the socket', () => {
    const { conn, transport } = build()
    const before = transport.sent.length
    transport.fireClose()
    conn.onChat({ chatId: CHAT, seq: 9, event: { kind: 'done', done: { conversationId: CHAT, turnId: AGENT } } })
    expect(transport.sent.length).toBe(before) // nothing appended post-close
  })
})
