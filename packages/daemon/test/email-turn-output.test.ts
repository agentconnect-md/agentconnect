// A turn's one mail (email-integration.md §6.1, §6.2): what is sent, to whom, and what the session keeps when it is not delivered.
import { describe, expect, it, vi } from 'vitest'
import type { RdPlatformReply, RdPlatformRequest, WireEmailAdapterExt, WireEmailCall } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  EmailConnection,
  emailSendOutcome,
  providerMessageId,
  type EmailStoredMail
} from '../src/platforms/email/connection.js'
import { EmailMembers, type EmailMembersDeps } from '../src/platforms/email/members.js'
import { emailHtml, emailReplyBodies, emailReplyReferences, emailReplySubject } from '../src/platforms/email/render.js'
import {
  applyEmailAction,
  emailFromName,
  EmailConverger,
  type EmailTurn,
  type EmailTurnHost,
  type EmailTurnState
} from '../src/platforms/email/turn-output.js'
import { PlatformRelayUnsent } from '../src/platforms/platform-relay.js'

const AGENT = 'helper@mail.example.test'
const AGENT_ID = '00000000-0000-4000-8000-0000000000a1'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const ALICE = 'alice@corp.example.test'
const BOB = 'bob@corp.example.test'
const OUTSIDER = 'pat@other.example.test'
const TICKET = 'e1.dGhyZWFk.1700000000000.bWFj'

function mail(over: Partial<WireEmailAdapterExt> = {}): WireEmailAdapterExt {
  return {
    from: { address: ALICE },
    to: [{ address: AGENT }],
    cc: [],
    subject: 'RE: Re: Plan',
    messageId: 'm2@corp.example.test',
    references: ['m1@corp.example.test'],
    attachments: [],
    ticket: TICKET,
    ...over
  }
}

type ReplyCall = Extract<WireEmailCall, { op: 'send' }>

const update = (text: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...extra }) as never

describe('the converger', () => {
  it('publishes nothing while the turn runs, and only the final answer at its end', () => {
    const conv = new EmailConverger('medium')
    expect(conv.onUpdate(update('Let me check.'))).toEqual([])
    expect(conv.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read' } as never)).toEqual([])
    expect(conv.onUpdate(update('The total is 42.'))).toEqual([])
    expect(conv.flushBuffered()).toEqual([])
    expect(conv.flushTerminal()).toEqual([])
    expect(conv.onFinal()).toEqual([{ kind: 'post', text: 'The total is 42.', attributed: false }])
    expect(conv.onFinal()).toEqual([])
  })

  it('keeps an answer in the session only in mode none, and sends nothing for the no-response marker', () => {
    const quiet = new EmailConverger('none')
    quiet.onUpdate(update('Done.'))
    expect(quiet.onFinal()).toEqual([{ kind: 'post', text: 'Done.', attributed: false, recordOnly: true }])
    const silent = new EmailConverger('medium')
    silent.onUpdate(update('AC_NO_RESPONSE'))
    expect(silent.onFinal()).toEqual([])
  })

  it('carries the footer attribution core hands it, which it gets only while the agent shows a footer', () => {
    const attribution = { botName: 'Helper', botUrl: '', runtime: 'Claude Code', model: 'opus', sessionUrl: '' }
    const conv = new EmailConverger('medium')
    conv.onUpdate(update('The total is 42.'))
    expect(conv.onFinal(attribution)).toEqual([
      { kind: 'post', text: 'The total is 42.', attributed: false, attribution }
    ])
  })
})

describe('rendering', () => {
  it('writes a single Re: and cuts References from the front past fifty', () => {
    expect(emailReplySubject('RE: re:Plan')).toBe('Re: Plan')
    expect(emailReplySubject('Plan')).toBe('Re: Plan')
    const chain = Array.from({ length: 50 }, (_, i) => `r${i}@x`)
    const refs = emailReplyReferences({ messageId: 'last@x', references: chain })
    expect(refs).toHaveLength(50)
    expect(refs[0]).toBe('r1@x')
    expect(refs.at(-1)).toBe('last@x')
  })

  it('sends the Markdown as written and as simple, escaped HTML', () => {
    expect(emailHtml('**Hi** <b>x</b>\n\n- [a](https://example.test)\n- [b](javascript:alert(1))')).toBe(
      '<p><strong>Hi</strong> &lt;b&gt;x&lt;/b&gt;</p>\n<ul>\n<li><a href="https://example.test">a</a></li>\n<li>b</li>\n</ul>'
    )
    const bodies = emailReplyBodies('  Hello  ')
    expect(bodies).toEqual({ text: 'Hello', html: '<p>Hello</p>', cut: false })
  })
})

describe('the sender’s display name', () => {
  it('is the agent’s name on one line within the limit, or left out', () => {
    expect(emailFromName(' Helper\r\nBcc: x ')).toBe('Helper Bcc: x')
    expect(emailFromName('a'.repeat(300))).toHaveLength(256)
    expect(emailFromName('  ')).toBeUndefined()
    expect(emailFromName(undefined)).toBeUndefined()
  })
})

describe('reading the relay’s answer', () => {
  it('tells sent, never sent and may have landed apart', () => {
    expect(
      emailSendOutcome({ outcome: 'ok', payload: { status: 200, body: { result: { id: '<x1@mail.example.test>' } } } })
    ).toEqual({
      outcome: 'sent',
      messageId: 'x1@mail.example.test'
    })
    expect(emailSendOutcome({ outcome: 'ok', payload: { status: 202, body: {} } })).toEqual({ outcome: 'sent' })
    expect(emailSendOutcome({ outcome: 'ok', payload: { status: 504 } }).outcome).toBe('unknown')
    expect(
      emailSendOutcome({
        outcome: 'ok',
        payload: { status: 400, body: { errors: [{ message: 'suppressed recipient' }] } }
      })
    ).toEqual({ outcome: 'unsent', reason: 'the mail provider refused it (400: suppressed recipient)' })
    expect(emailSendOutcome({ outcome: 'refused', reason: 'ticket' })).toEqual({
      outcome: 'unsent',
      reason: 'the relay refused it (ticket)'
    })
    expect(emailSendOutcome({ outcome: 'refused', reason: 'not_configured', retryable: true }).retryable).toBe(true)
    expect(emailSendOutcome({ outcome: 'unavailable' }).retryable).toBe(true)
    expect(providerMessageId({ id: 'no-at-sign' })).toBeUndefined()
  })
})

interface Harness {
  state: EmailTurnState
  host: EmailTurnHost<EmailTurn>
  turn: EmailTurn
  requests: RdPlatformRequest[]
  transcript: { text: string; ts: string }[]
  index: Record<string, unknown>[]
  recorded: string[]
}

function harness(opts: {
  ext?: WireEmailAdapterExt
  channel?: string
  replies?: (RdPlatformReply | Error)[]
  ask?: EmailMembersDeps['ask']
  latest?: EmailStoredMail
  wrote?: string[]
}): Harness {
  const requests: RdPlatformRequest[] = []
  const replies = [
    ...(opts.replies ?? [
      { outcome: 'ok', payload: { status: 200, body: { result: { messageId: 'sent1@mail.example.test' } } } }
    ])
  ]
  const conn = new EmailConnection({
    group: {
      key: AGENT,
      config: { address: AGENT, egress: 'relay', botId: BOT },
      integrations: [{ agentId: AGENT_ID, integrationId: 'int-email' }]
    },
    relay: {
      request: async (req) => {
        requests.push(req)
        const next = replies.shift() ?? { outcome: 'ok', payload: { status: 200 } }
        if (next instanceof Error) throw next
        return next
      }
    },
    store: () => ({ emailMessages: {} as never, admittedTextRowsByTs: async () => [] }),
    transcriptChannel: (channel) => channel,
    sleep: async () => {}
  })
  vi.spyOn(conn, 'latestReceived').mockResolvedValue(opts.latest)
  vi.spyOn(conn, 'threadSenders').mockResolvedValue(new Set(opts.wrote ?? []))
  const transcript: { text: string; ts: string }[] = []
  const index: Record<string, unknown>[] = []
  const recorded: string[] = []
  let ts = 0
  const members = new EmailMembers({
    ask:
      opts.ask ??
      (async (_a, addresses) => ({
        members: addresses.map((address) => ({ address, consoleUserId: `u-${address}` }))
      })),
    now: () => 0
  })
  const host: EmailTurnHost<EmailTurn> = {
    recordReplySegment: async (_turn, text) => void recorded.push(text),
    appendTranscript: async (row) => void transcript.push({ text: row.text, ts: row.ts }),
    monotonicTs: () => `ts${++ts}`,
    members: () => members,
    store: () => ({
      emailMessages: { record: async (row: Record<string, unknown>) => (index.push(row), true) } as never
    }),
    agentName: () => 'Helper',
    now: () => 9,
    warn: () => {}
  }
  const channel = opts.channel ?? `dm:${ALICE}`
  const message = {
    platform: 'email',
    channel,
    thread: 'm1@corp.example.test',
    ...(opts.ext ? { adapterExt: { email: opts.ext } } : {})
  } as unknown as NormalizedMessage
  const turn: EmailTurn = {
    plan: { transcriptChannel: channel, statusThread: 'm1@corp.example.test', agentId: AGENT_ID, sessionKey: 'k' }
  }
  return { state: { conn, message }, host, turn, requests, transcript, index, recorded }
}

const send = (h: Harness, text = 'The total is **42**.') =>
  applyEmailAction(h.host, h.turn, h.state, { kind: 'post', text })

describe('delivering the reply', () => {
  it('answers the sender of a direct thread with the threading headers and both bodies', async () => {
    const h = harness({ ext: mail() })
    await send(h)
    const call = h.requests[0]!.payload as ReplyCall
    expect(h.requests[0]).toMatchObject({ platformId: 'email', botId: BOT })
    expect(call).toEqual({
      op: 'send',
      ticket: TICKET,
      audience: [ALICE],
      to: [ALICE],
      cc: [],
      fromName: 'Helper',
      subject: 'Re: Plan',
      inReplyTo: 'm2@corp.example.test',
      references: ['m1@corp.example.test', 'm2@corp.example.test'],
      text: 'The total is **42**.',
      html: '<p>The total is <strong>42</strong>.</p>'
    })
    expect(h.transcript).toEqual([{ text: 'The total is **42**.', ts: 'ts1' }])
    expect(h.index[0]).toMatchObject({
      address: AGENT,
      messageId: 'sent1@mail.example.test',
      thread: 'm1@corp.example.test',
      conversation: `dm:${ALICE}`,
      direction: 'sent',
      outcome: 'sent',
      ts: 'ts1'
    })
    // One mail a turn: a second post is kept in the session only.
    await send(h, 'again')
    expect(h.requests).toHaveLength(1)
    expect(h.recorded).toEqual(['again'])
  })

  it('copies the group’s other members and leaves everyone else off, in one question', async () => {
    const ask = vi.fn<EmailMembersDeps['ask']>(async (_a, addresses) => ({
      members: addresses.filter((a) => a !== OUTSIDER).map((address) => ({ address, consoleUserId: `u-${address}` }))
    }))
    const h = harness({
      ext: mail({ cc: [{ address: BOB }, { address: OUTSIDER }] }),
      channel: 'group:m1@corp.example.test',
      ask
    })
    await send(h)
    const call = h.requests[0]!.payload as ReplyCall
    expect(call.audience).toEqual([ALICE, BOB, OUTSIDER])
    expect(call.to).toEqual([ALICE])
    expect(call.cc).toEqual([BOB])
    expect(call.outside).toBeUndefined()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(h.transcript).toHaveLength(1)
  })

  describe('under Anyone (§6.1, §6.4)', () => {
    // Alice and Bob are members; everyone else is outside and may write now.
    const anyone: EmailMembersDeps['ask'] = async (_a, addresses) => ({
      members: addresses
        .filter((a) => a === ALICE || a === BOB)
        .map((address) => ({ address, consoleUserId: `u-${address}` })),
      outsiders: addresses.filter((a) => a !== ALICE && a !== BOB),
      outsideSenders: 'admitted'
    })
    const NAMED = 'named@other.example.test'

    it('answers an outside sender’s direct thread on the outside budget, without asking', async () => {
      const ask = vi.fn(anyone)
      const h = harness({ ext: mail({ from: { address: OUTSIDER }, outsider: true }), channel: `dm:${OUTSIDER}`, ask })
      await send(h)
      const call = h.requests[0]!.payload as ReplyCall
      expect(call.to).toEqual([OUTSIDER])
      expect(call.outside).toBe(true)
      expect(ask).not.toHaveBeenCalled()
    })

    it('copies an outsider only once they have written on the thread themselves', async () => {
      const ext = mail({ cc: [{ address: BOB }, { address: OUTSIDER }, { address: NAMED }] })
      const h = harness({ ext, channel: 'group:m1@corp.example.test', ask: anyone, wrote: [ALICE, OUTSIDER] })
      await send(h)
      const call = h.requests[0]!.payload as ReplyCall
      // A name in a Cc header is the sender's own text: someone who never wrote is left off.
      expect(call.cc).toEqual([BOB, OUTSIDER])
      expect(call.outside).toBe(true)
    })

    it('keeps a members-only reply on the member budget even with an outsider left off', async () => {
      const ext = mail({ cc: [{ address: BOB }, { address: NAMED }] })
      const h = harness({ ext, channel: 'group:m1@corp.example.test', ask: anyone })
      await send(h)
      const call = h.requests[0]!.payload as ReplyCall
      expect(call.cc).toEqual([BOB])
      expect(call.outside).toBeUndefined()
    })

    it('copies no outsider while outside mail is refused, whoever wrote', async () => {
      const closed: EmailMembersDeps['ask'] = async (agent, addresses) => ({
        ...(await anyone(agent, addresses))!,
        outsideSenders: 'refused'
      })
      const ext = mail({ cc: [{ address: OUTSIDER }] })
      const h = harness({ ext, channel: 'group:m1@corp.example.test', ask: closed, wrote: [OUTSIDER] })
      await send(h)
      expect((h.requests[0]!.payload as ReplyCall).cc).toEqual([])
    })

    it('marks an outside sender’s group reply outside when the Control Plane cannot be asked', async () => {
      const ext = mail({ from: { address: OUTSIDER }, outsider: true, cc: [{ address: BOB }] })
      const h = harness({ ext, channel: 'group:m1@corp.example.test', ask: async () => undefined })
      await send(h)
      const call = h.requests[0]!.payload as ReplyCall
      expect(call.cc).toEqual([])
      expect(call.outside).toBe(true)
    })
  })

  it('sends to the sender alone when the Control Plane cannot be asked, and the session says so', async () => {
    const h = harness({
      ext: mail({ cc: [{ address: BOB }] }),
      channel: 'group:m1@corp.example.test',
      ask: async () => undefined
    })
    await send(h)
    expect((h.requests[0]!.payload as ReplyCall).cc).toEqual([])
    expect(h.transcript[1]!.text).toContain(`This reply went to ${ALICE} only`)
    expect(h.transcript[1]!.text).toContain(BOB)
  })

  it('keeps a refused reply in the session marked undelivered, and never repeats one that may have landed', async () => {
    const refused = harness({ ext: mail(), replies: [{ outcome: 'refused', reason: 'budget_bot' }] })
    await send(refused)
    expect(refused.requests).toHaveLength(1)
    expect(refused.transcript.map((r) => r.text)).toEqual([
      'The total is **42**.',
      '⚠️ This reply was not sent by mail: the relay refused it (budget_bot).'
    ])
    expect(refused.index[0]).toMatchObject({ outcome: 'unsent', reason: 'the relay refused it (budget_bot)' })
    const landed = harness({ ext: mail(), replies: [{ outcome: 'ok', payload: { status: 504 } }] })
    await send(landed)
    expect(landed.requests).toHaveLength(1)
    expect(landed.index[0]).toMatchObject({ outcome: 'unknown' })
    const cut = harness({ ext: mail(), replies: [new Error('socket closed')] })
    await send(cut)
    expect(cut.requests).toHaveLength(1)
    expect(cut.index[0]).toMatchObject({ outcome: 'unknown' })
  })

  it('tries again a send that never reached the provider', async () => {
    const h = harness({
      ext: mail(),
      replies: [
        new PlatformRelayUnsent('no relay'),
        { outcome: 'refused', reason: 'not_configured', retryable: true },
        { outcome: 'ok', payload: { status: 200 } }
      ]
    })
    await send(h)
    expect(h.requests).toHaveLength(3)
    expect(h.index[0]).toMatchObject({ outcome: 'sent' })
    expect(h.index[0]!.messageId).toBeUndefined()
  })

  it('answers a thread’s latest mail when the turn’s own message carries none, and records only for mode none', async () => {
    const h = harness({ latest: { ...mail({ messageId: 'm9@corp.example.test' }), participants: [ALICE] } })
    await send(h)
    expect((h.requests[0]!.payload as ReplyCall).inReplyTo).toBe('m9@corp.example.test')
    const quiet = harness({ ext: mail() })
    await applyEmailAction(quiet.host, quiet.turn, quiet.state, { kind: 'post', text: 'x', recordOnly: true })
    await applyEmailAction(quiet.host, quiet.turn, quiet.state, { kind: 'notice', text: 'waiting' })
    expect(quiet.requests).toHaveLength(0)
    expect(quiet.recorded).toEqual(['x', 'waiting'])
  })

  it('mails the footer the agent’s setting asks for under the answer, but keeps the session text without it', async () => {
    const attribution = {
      botName: 'Helper',
      botUrl: 'https://console.example.test/agents/a1',
      runtime: 'Claude Code',
      model: 'opus',
      sessionUrl: 'https://console.example.test/sessions/s1'
    }
    const h = harness({ ext: mail() })
    await applyEmailAction(h.host, h.turn, h.state, { kind: 'post', text: 'The total is 42.', attribution })
    const call = h.requests[0]!.payload as ReplyCall
    expect(call.text).toBe(
      'The total is 42.\n\n---\n\nsent by [Helper](https://console.example.test/agents/a1) (Claude Code · opus) · ' +
        '[open in session](https://console.example.test/sessions/s1)'
    )
    expect(h.transcript[0]!.text).toBe('The total is 42.')
    // A reply that reaches anyone outside the organization carries no footer at all.
    const outside = harness({
      ext: { ...mail(), outsider: true },
      ask: async () => ({ members: [] })
    })
    await applyEmailAction(outside.host, outside.turn, outside.state, { kind: 'post', text: 'Hi.', attribution })
    expect((outside.requests[0]!.payload as ReplyCall).text).toBe('Hi.')
    // With the footer turned off the converger hands over no attribution, and the mail is the answer alone.
    const plain = harness({ ext: mail() })
    await send(plain, 'Only this.')
    expect((plain.requests[0]!.payload as ReplyCall).text).toBe('Only this.')
  })

  it('keeps core chrome such as a status bar out of the session and out of the mail', async () => {
    const h = harness({ ext: mail() })
    await applyEmailAction(h.host, h.turn, h.state, { kind: 'status-bar', text: ':bar_chart: _default_ · ctx 24k' })
    await applyEmailAction(h.host, h.turn, h.state, { kind: 'clear-status-bar', text: ':bar_chart: —' })
    expect(h.requests).toHaveLength(0)
    expect(h.recorded).toEqual([])
  })

  it('marks a reply undelivered when the mail it answers has no ticket', async () => {
    const h = harness({ ext: mail({ ticket: undefined }) })
    await send(h)
    expect(h.requests).toHaveLength(0)
    expect(h.index[0]).toMatchObject({ outcome: 'unsent', reason: 'the mail it answers carries no reply ticket' })
  })
})
