import { describe, it, expect, vi } from 'vitest'
import type { RdAck, RdMsgWebchat, WebchatRemoteMcpEntitlement } from '@agentconnect.md/protocol'
import { WireError, type ServerTransport } from '@agentconnect.md/connection'
import { RelayBrowserConnection, parseBrowserFrame } from './relay-browser-connection.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const CHAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT = '11111111-1111-4111-8111-111111111111'
const DAEMON = '99999999-9999-4999-8999-999999999999'
const USER = 'ada@example.com'
const PICTURE = 'https://cdn.example.test/avatars/user-1.png'
const ENTITLEMENT: WebchatRemoteMcpEntitlement = {
  authorityId: '33333333-3333-4333-8333-333333333333',
  authorityGeneration: 7,
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
    remoteMcp?: WebchatRemoteMcpEntitlement
    log?: Logger
    participants?: Array<{ agentId: string; daemonId?: string; primary?: boolean }>
    targetSessionId?: string
    supports?: boolean
  } = {}
) {
  const sent: RdMsgWebchat[] = []
  const sendMsg = vi.fn(async (m: RdMsgWebchat): Promise<RdAck> => {
    sent.push(m)
    return over.ack ?? { msgId: m.msgId, accepted: true }
  })
  const daemon =
    'daemon' in over
      ? over.daemon
      : ({ sendMsg, supports: () => over.supports !== false } as unknown as RelayDaemonConnection)
  const register = vi.fn()
  const unregister = vi.fn()
  const transport = new FakeBrowserTransport()
  const conn = new RelayBrowserConnection(transport, {
    chatId: CHAT,
    agentId: AGENT,
    participants: over.participants ?? [{ agentId: AGENT, daemonId: DAEMON, primary: true }],
    user: USER,
    ...(over.targetSessionId ? { targetSessionId: over.targetSessionId } : {}),
    ...(over.remoteMcp ? { remoteMcp: over.remoteMcp } : {}),
    daemonConnFor: () => daemon,
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
    expect(parseBrowserFrame({ text: 'hi' }, USER)).toEqual({ op: { op: 'turn', text: 'hi', user: USER } })
    expect(parseBrowserFrame({ type: 'message', text: 'hi', turnId: AGENT }, USER)).toEqual({
      op: {
        op: 'turn',
        text: 'hi',
        user: USER,
        turnId: AGENT
      }
    })
  })
  it('carries staged runtime and worktree choices on the first turn', () => {
    const runtime = { model: 'gpt-5.6-sol', effort: 'xhigh', permissionMode: 'full-access', fastMode: true }
    expect(parseBrowserFrame({ text: 'hi', runtime, worktree: false }, USER)).toEqual({
      op: {
        op: 'turn',
        text: 'hi',
        user: USER,
        runtime,
        worktree: false
      }
    })
    expect(parseBrowserFrame({ text: 'hi', runtime: { fastMode: 'yes' } }, USER)).toBeNull()
    expect(parseBrowserFrame({ text: 'hi', worktree: 'yes' }, USER)).toBeNull()
  })
  it('maps a bounded image attachment while keeping the verified user authoritative', () => {
    const attachment = {
      name: 'screen.webp',
      mimeType: 'image/webp',
      data: Buffer.from('image').toString('base64')
    }
    expect(parseBrowserFrame({ text: '', user: 'spoofed', attachments: [attachment] }, USER)).toEqual({
      op: {
        op: 'turn',
        text: '',
        user: USER,
        attachments: [attachment]
      }
    })
    expect(parseBrowserFrame({ text: '', attachments: [{ ...attachment, data: 'invalid' }] }, USER)).toBeNull()
  })
  it("carries the verified stable principal beside the display handle, never the browser's", () => {
    expect(parseBrowserFrame({ text: 'hi', userId: 'spoofed' }, USER, 'user-1')).toEqual({
      op: { op: 'turn', text: 'hi', user: USER, userId: 'user-1' }
    })
    // The avatar rides the same verdict, so a browser cannot pick the identity a mirror posts under.
    expect(
      parseBrowserFrame({ text: 'hi', userPicture: 'https://evil.example.test/x.png' }, USER, 'user-1', PICTURE)
    ).toEqual({ op: { op: 'turn', text: 'hi', user: USER, userId: 'user-1', userPicture: PICTURE } })
    // A CP that returns no principal leaves the claim off entirely, rather than
    // inventing one from the handle — the daemon owns that fallback.
    expect(parseBrowserFrame({ text: 'hi' }, USER)).toEqual({ op: { op: 'turn', text: 'hi', user: USER } })
  })
  it('maps the session-control envelopes', () => {
    expect(parseBrowserFrame({ type: 'resume', turnId: AGENT, generation: 3, afterIndex: 4 }, USER)).toEqual({
      op: {
        op: 'resume',
        turnId: AGENT,
        generation: 3,
        afterIndex: 4
      }
    })
    expect(parseBrowserFrame({ type: 'set_model', model: 'claude' }, USER)).toEqual({
      op: { op: 'set_model', model: 'claude' }
    })
    expect(parseBrowserFrame({ type: 'set_effort', effort: 'high' }, USER)).toEqual({
      op: { op: 'set_effort', effort: 'high' }
    })
    expect(parseBrowserFrame({ type: 'set_permission_mode', permissionMode: 'plan' }, USER)).toEqual({
      op: { op: 'set_permission_mode', permissionMode: 'plan' }
    })
    expect(parseBrowserFrame({ type: 'set_fast', fastMode: true }, USER)).toEqual({
      op: { op: 'set_fast', fastMode: true }
    })
    expect(parseBrowserFrame({ type: 'cancel' }, USER)).toEqual({ op: { op: 'cancel' } })
    expect(parseBrowserFrame({ type: 'attach' }, USER)).toEqual({ op: { op: 'attach' } })
    expect(parseBrowserFrame({ type: 'attach', agentId: AGENT }, USER)).toEqual({
      op: { op: 'attach', agentId: AGENT }
    })
    expect(parseBrowserFrame({ type: 'attach', agentId: 'not-a-uuid' }, USER)).toBeNull()
  })
  it('maps the elicitation answer, Dismiss included, and rejects a malformed one', () => {
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: 'yes' }, USER)).toEqual({
      op: { op: 'elicitation_choice', requestId: 'elicit-1', value: 'yes' }
    })
    // null is Dismiss and must survive parsing as null — not be dropped into an absent field.
    expect(
      parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: null, agentId: AGENT }, USER)
    ).toEqual({ op: { op: 'elicitation_choice', requestId: 'elicit-1', value: null, agentId: AGENT } })
    // A multi-select answers with the chosen list; anything else in it is not an answer.
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: ['a', 'b'] }, USER)).toEqual({
      op: { op: 'elicitation_choice', requestId: 'elicit-1', value: ['a', 'b'] }
    })
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: [] }, USER)).toEqual({
      op: { op: 'elicitation_choice', requestId: 'elicit-1', value: [] }
    })
    // A typed field answers with a real number; a non-finite one is not a number a schema means.
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: 42 }, USER)).toEqual({
      op: { op: 'elicitation_choice', requestId: 'elicit-1', value: 42 }
    })
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: Number.NaN }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1', value: ['a', 7] }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: 'elicit-1' }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'elicitation_choice', value: 'yes' }, USER)).toBeNull()
    expect(parseBrowserFrame({ type: 'elicitation_choice', requestId: '', value: 'yes' }, USER)).toBeNull()
    expect(
      parseBrowserFrame({ type: 'elicitation_choice', requestId: 'e', value: 'yes', agentId: 'not-a-uuid' }, USER)
    ).toBeNull()
  })
  it('preserves structured mentions on the turn op and surfaces targets separately', () => {
    const PEER = '22222222-2222-4222-8222-222222222222'
    expect(parseBrowserFrame({ text: 'hi', mentions: [AGENT, PEER], targets: [AGENT, PEER] }, USER)).toEqual({
      op: { op: 'turn', text: 'hi', user: USER, mentions: [AGENT, PEER] },
      targets: [AGENT, PEER]
    })
    expect(parseBrowserFrame({ text: 'hi', mentions: ['not-a-uuid'] }, USER)).toEqual({
      op: { op: 'turn', text: 'hi', user: USER }
    })
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
    expect(transport.last('ready')).toEqual({
      type: 'ready',
      conversationId: CHAT,
      agentId: AGENT,
      participants: [{ agentId: AGENT, primary: true }]
    })
  })

  it('stamps the verdict targetSessionId verbatim onto every rd/msg — turn and close alike', async () => {
    const TARGET = 'acp-session-cont-1'
    const { conn, transport, sent } = build({ targetSessionId: TARGET })
    transport.feed(JSON.stringify({ text: 'continue this' }))
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ chatId: CHAT, targetSessionId: TARGET, payload: { op: 'turn' } })
    conn['onClose']()
    await tick()
    expect(sent.at(-1)).toMatchObject({ targetSessionId: TARGET, payload: { op: 'close' } })
  })

  it('forwards structured mentions inside every per-target rd/msg(turn) payload', async () => {
    const PEER = '22222222-2222-4222-8222-222222222222'
    const { transport, sent } = build({
      participants: [
        { agentId: AGENT, daemonId: DAEMON, primary: true },
        { agentId: PEER, daemonId: DAEMON }
      ]
    })
    transport.feed({ text: 'hi', mentions: [AGENT, PEER], targets: [AGENT, PEER] })
    await tick()
    expect(sent).toHaveLength(2)
    expect(sent.map((frame) => frame.agentId).sort()).toEqual([AGENT, PEER].sort())
    for (const frame of sent) {
      expect(frame.payload).toMatchObject({ op: 'turn', text: 'hi', mentions: [AGENT, PEER] })
    }
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
    expect(transport.last('ack')).toEqual({ type: 'ack', ack: { accepted: true, agentId: AGENT } })
  })

  it('copies the verified remote-MCP entitlement to every webchat operation', async () => {
    const { transport, sent } = build({ remoteMcp: ENTITLEMENT })
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
    expect(sent.map(({ remoteMcp }) => remoteMcp)).toEqual(
      Array.from({ length: operations.length + 1 }, () => ENTITLEMENT)
    )
    expect(sent.at(-1)?.payload).toEqual({ op: 'close' })
  })

  it('routes an elicitation answer to the participant whose card it is', async () => {
    const PEER = '22222222-2222-4222-8222-222222222222'
    const { transport, sent } = build({
      participants: [
        { agentId: AGENT, daemonId: DAEMON, primary: true },
        { agentId: PEER, daemonId: DAEMON }
      ]
    })
    transport.feed({ type: 'elicitation_choice', requestId: 'elicit-3', value: 'yes', agentId: PEER })
    transport.feed({ type: 'elicitation_choice', requestId: 'elicit-4', value: null })
    await tick()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({
      agentId: PEER,
      chatId: CHAT,
      payload: { op: 'elicitation_choice', requestId: 'elicit-3', value: 'yes' }
    })
    // No agentId named ⇒ the conversation's primary, exactly like `cancel`.
    expect(sent[1]).toMatchObject({
      agentId: AGENT,
      payload: { op: 'elicitation_choice', requestId: 'elicit-4', value: null }
    })
  })

  it('keeps ordinary browser connections entitlement-free', async () => {
    const { transport, sent } = build()
    transport.feed({ text: 'ordinary webchat' })
    transport.fireClose()
    await tick()

    expect(sent).toHaveLength(2)
    expect(sent.every((message) => message.remoteMcp === undefined)).toBe(true)
  })

  it('does not parse browser entitlement fields at any nesting depth', () => {
    const forged = {
      authorityId: '44444444-4444-4444-8444-444444444444',
      authorityGeneration: 999,
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    const parsed = parseBrowserFrame(
      {
        type: 'message',
        text: 'try to escape',
        remoteMcp: forged,
        payload: { remoteMcp: forged },
        runtime: { model: 'claude', remoteMcp: forged }
      },
      USER
    )

    expect(parsed).toEqual({ op: { op: 'turn', text: 'try to escape', user: USER, runtime: { model: 'claude' } } })
    expect(parsed).not.toHaveProperty('op.remoteMcp')
    expect(parsed).not.toHaveProperty('op.payload')
    expect(parsed).not.toHaveProperty('op.runtime.remoteMcp')
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
    expect(transport.last('ack')).toEqual({ type: 'ack', ack: { accepted: false, agentId: AGENT, reason: 'paused' } })
  })

  it('forwards a resume cursor and surfaces its replay verdict', async () => {
    const turnId = '22222222-2222-4222-8222-222222222222'
    const { transport, sent } = build({ ack: { msgId: 'resume-1', accepted: true, turnId } })
    transport.feed({ type: 'resume', turnId, generation: 4, afterIndex: 7 })
    await tick()
    expect(sent[0]).toMatchObject({ payload: { op: 'resume', turnId, generation: 4, afterIndex: 7 } })
    expect(transport.last('resumed')).toEqual({
      type: 'resumed',
      ack: { accepted: true, turnId, agentId: AGENT }
    })
  })

  it('forwards an attach probe and surfaces the named stream on {type:"attached"}', async () => {
    const turnId = '22222222-2222-4222-8222-222222222222'
    const { transport, sent } = build({ ack: { msgId: 'attach-1', accepted: true, turnId, generation: 2 } })
    transport.feed({ type: 'attach', agentId: AGENT })
    await tick()
    expect(sent[0]).toMatchObject({ agentId: AGENT, payload: { op: 'attach', agentId: AGENT } })
    expect(transport.last('attached')).toEqual({
      type: 'attached',
      ack: { accepted: true, turnId, agentId: AGENT, generation: 2 }
    })
  })

  it('refuses the attach probe locally for a daemon without webchat-attach-v1', async () => {
    const { transport, sent } = build({ supports: false })
    transport.feed({ type: 'attach', agentId: AGENT })
    await tick()
    expect(sent).toHaveLength(0)
    expect(transport.last('attached')).toEqual({
      type: 'attached',
      ack: { accepted: false, agentId: AGENT, reason: 'unsupported' }
    })
  })

  it('answers the attach probe with a quiet per-agent refusal when the daemon is offline', async () => {
    const { transport } = build({ daemon: undefined })
    transport.feed({ type: 'attach' })
    await tick()
    expect(transport.last('attached')).toEqual({
      type: 'attached',
      ack: { accepted: false, agentId: AGENT, reason: 'no_agent' }
    })
    expect(transport.last('error')).toBeUndefined()
  })

  // A stream that "never came back" is diagnosed from these lines alone: who joined/left the
  // conversation (with the close code), and which daemon refused a resume, and why.
  it('logs the browser join/leave and every refused resume with the daemon and reason', async () => {
    const turnId = '22222222-2222-4222-8222-222222222222'
    const lines: string[] = []
    const log: Logger = { debug: () => {}, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: () => {} }
    const { conn, transport } = build({
      log,
      ack: { msgId: 'resume-1', accepted: false, reason: 'stream_not_found' }
    })
    expect(lines[0]).toMatch(new RegExp(`browser joined conversation ${CHAT} \\(1 participant`))
    transport.feed({ type: 'resume', turnId, generation: 4, afterIndex: 7 })
    await tick()
    expect(lines.at(-1)).toBe(
      `webchat: resume ${turnId} for ${AGENT} in ${CHAT} refused by ${DAEMON}: stream_not_found`
    )
    conn['onClose'](1006, '')
    expect(lines.at(-1)).toBe(`webchat: browser left conversation ${CHAT} (close 1006)`)
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
      participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }],
      user: USER,
      daemonConnFor: () => daemon,
      register: vi.fn(),
      unregister: vi.fn(),
      log: silentLog
    }).start()
    transport.feed({ text: 'hi' })
    await tick()
    expect(transport.last('error')).toEqual({ type: 'error', message: 'delivery failed' })
  })

  it('logs safe delivery-failure categories without raw messages, details, payload, or entitlement fields', async () => {
    const sensitivePayload = `browser said secret; remoteMcp=${JSON.stringify(ENTITLEMENT)}`
    const cases: Array<{ error: unknown; diagnostic: string }> = [
      {
        error: new WireError('INTERNAL', `no ack after 5 tries for ${ENTITLEMENT.authorityId}`, true),
        diagnostic: 'kind=ack_timeout code=INTERNAL retryable=true'
      },
      {
        error: new WireError('INTERNAL', 'connection closed', true),
        diagnostic: 'kind=connection_closed code=INTERNAL retryable=true'
      },
      {
        error: new WireError('BAD_PAYLOAD', `invalid correlated reply: ${sensitivePayload}`, false, {
          remoteMcp: ENTITLEMENT,
          payload: sensitivePayload
        }),
        diagnostic: 'kind=remote_protocol code=BAD_PAYLOAD retryable=false'
      },
      {
        error: new WireError(`secret-${ENTITLEMENT.authorityGeneration}`, sensitivePayload, false),
        diagnostic: 'kind=unknown_wire_error'
      },
      {
        error: new Error(sensitivePayload),
        diagnostic: 'kind=unknown_error'
      }
    ]

    for (const { error, diagnostic } of cases) {
      const warnings: string[] = []
      const log: Logger = {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {}
      }
      const sendMsg = vi.fn(async () => {
        throw error
      })
      const { transport } = build({
        daemon: { sendMsg } as unknown as RelayDaemonConnection,
        remoteMcp: ENTITLEMENT,
        log
      })

      transport.feed({ text: sensitivePayload })
      await tick()

      expect(warnings).toEqual([`relay: webchat op delivery failed ${diagnostic}`])
      const observable = JSON.stringify({ warnings, browserError: transport.last('error') })
      expect(observable).not.toContain(ENTITLEMENT.authorityId)
      expect(observable).not.toContain(String(ENTITLEMENT.authorityGeneration))
      expect(observable).not.toContain(ENTITLEMENT.expiresAt)
      expect(observable).not.toContain(sensitivePayload)
    }
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
      remoteMcp: ENTITLEMENT
    })

    transport.feed({ text: 'long turn' })
    await tick()
    transport.fireClose()
    await tick()
    completeTurn({ msgId: delivered[0]!.msgId, accepted: true })
    await tick()

    expect(delivered.map(({ payload }) => payload.op)).toEqual(['turn', 'close'])
    expect(delivered[0]?.remoteMcp).toEqual(ENTITLEMENT)
    expect(delivered[1]?.remoteMcp).toEqual(ENTITLEMENT)
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

describe('webchat rendezvous fallback (rollout replaced the recorded daemon)', () => {
  const DAEMON2 = '88888888-8888-4888-8888-888888888888'
  const DAEMON3 = '77777777-7777-4777-8777-777777777777'

  function buildRouted(opts: { conns: Record<string, RdAck | 'accept'>; rendezvous?: string }) {
    const calls: Array<{ daemonId: string; msg: RdMsgWebchat }> = []
    const connFor = (daemonId: string): RelayDaemonConnection | undefined => {
      const verdict = opts.conns[daemonId]
      if (!verdict) return undefined
      return {
        sendMsg: async (msg: RdMsgWebchat): Promise<RdAck> => {
          calls.push({ daemonId, msg })
          return verdict === 'accept' ? { msgId: msg.msgId, accepted: true } : verdict
        }
      } as unknown as RelayDaemonConnection
    }
    const rendezvous = vi.fn(() => {
      const id = opts.rendezvous
      const conn = id ? connFor(id) : undefined
      return id && conn ? { daemonId: id, conn } : undefined
    })
    const transport = new FakeBrowserTransport()
    new RelayBrowserConnection(transport, {
      chatId: CHAT,
      agentId: AGENT,
      participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }],
      user: USER,
      daemonConnFor: connFor,
      rendezvousDaemonConn: rendezvous,
      register: vi.fn(),
      unregister: vi.fn(),
      log: silentLog
    }).start()
    return { transport, calls, rendezvous }
  }

  it('delivers through a live same-org member when the recorded daemon is gone', async () => {
    const { transport, calls } = buildRouted({ conns: { [DAEMON2]: 'accept' }, rendezvous: DAEMON2 })
    transport.feed({ text: 'hi' })
    await tick()
    expect(calls.map((c) => c.daemonId)).toEqual([DAEMON2])
    expect(transport.last('ack')).toMatchObject({ ack: { accepted: true, agentId: AGENT } })
    expect(transport.last('error')).toBeUndefined()
  })

  it('heals the roster: the next op goes direct instead of repeating the rendezvous', async () => {
    const { transport, calls, rendezvous } = buildRouted({ conns: { [DAEMON2]: 'accept' }, rendezvous: DAEMON2 })
    transport.feed({ text: 'hi' })
    await tick()
    transport.feed({ text: 'again' })
    await tick()
    expect(calls.map((c) => c.daemonId)).toEqual([DAEMON2, DAEMON2])
    expect(rendezvous).toHaveBeenCalledTimes(1)
  })

  it('keeps the offline error when no same-org member is connected', async () => {
    const { transport, calls } = buildRouted({ conns: {} })
    transport.feed({ text: 'hi' })
    await tick()
    expect(calls).toEqual([])
    expect(transport.last('error')).toEqual({ type: 'error', message: 'agent daemon offline' })
  })

  it('follows a not_holder verdict from the rendezvous member to the named holder', async () => {
    const { transport, calls } = buildRouted({
      conns: {
        [DAEMON2]: { msgId: 'x', accepted: false, reason: 'not_holder', holderDaemonId: DAEMON3 },
        [DAEMON3]: 'accept'
      },
      rendezvous: DAEMON2
    })
    transport.feed({ text: 'hi' })
    await tick()
    expect(calls.map((c) => c.daemonId)).toEqual([DAEMON2, DAEMON3])
    expect(transport.last('ack')).toMatchObject({ ack: { accepted: true, agentId: AGENT } })
    // Healed to the holder: a second op goes straight to it.
    transport.feed({ text: 'again' })
    await tick()
    expect(calls.map((c) => c.daemonId)).toEqual([DAEMON2, DAEMON3, DAEMON3])
  })

  it('heals after the ordinary holder re-route when the recorded daemon still answers', async () => {
    const { transport, calls } = buildRouted({
      conns: {
        [DAEMON]: { msgId: 'x', accepted: false, reason: 'not_holder', holderDaemonId: DAEMON3 },
        [DAEMON3]: 'accept'
      }
    })
    transport.feed({ text: 'hi' })
    await tick()
    transport.feed({ text: 'again' })
    await tick()
    expect(calls.map((c) => c.daemonId)).toEqual([DAEMON, DAEMON3, DAEMON3])
  })
})
