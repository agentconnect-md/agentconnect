// Mail the agent starts (email-integration.md §5.1–§5.3, §6.1, §6.4): the tool's rules, the started thread's record and ownership, and the replies that find it.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMAIL_MEMBERS_V1_FEATURE,
  EMAIL_MESSAGE_ID_PATTERN,
  EMAIL_STARTED_TAG_PATTERN,
  type RdMsgIm,
  type WireEmailAdapterExt,
  type WireEmailCall
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { memberTurnConsoleUsers } from '../src/assistant/member-turn.js'
import type { TurnMessage } from '../src/assistant/place-members.js'
import type { ReplyAttributionInfo } from '../src/messages/attribution.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  EMAIL_AGENT_TOOLS,
  mintEmailStartedTag,
  emailOriginNote,
  startEmail,
  startedRecipients,
  startedThreadPlace,
  type EmailStartDeps
} from '../src/platforms/email/agent-tools.js'
import type { EmailConnection, EmailSendResult } from '../src/platforms/email/connection.js'
import { EmailMembers, type EmailMembersDeps, type EmailMemberVerdict } from '../src/platforms/email/members.js'
import { emailRelayIngress, emailStartedNotes } from '../src/platforms/email/module.js'
import {
  emailStartedReplyThread,
  emailStartedTagOf,
  placeEmail,
  type EmailPlacementIndex,
  type EmailStartedThread
} from '../src/platforms/email/threading.js'
import { emailReplyAudience } from '../src/platforms/email/turn-output.js'
import type { PlatformConversationSeed } from '../src/platforms/read-ports.js'
import { agentToolInstructions, agentToolsFor } from '../src/platforms/read-ports.js'
import { ALL_TOOL_NAMES, toolsForIntegrations } from '../src/mcp/tools.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { transcriptChannelKey } from '../src/store/local-store.js'

const AGENT = 'helper@mail.example.test'
const AGENT_ID = '00000000-0000-4000-8000-0000000000a1'
const ALICE = 'alice@corp.example.test'
const BOB = 'bob@corp.example.test'
const STRANGER = 'stranger@other.example.test'
const PAT = 'pat@other.example.test'
const TAG = 'abcdefghijklmnopqrst'

// The Control Plane's answer: these members, and every other address one no member holds.
const answer =
  (members: (address: string) => boolean): EmailMembersDeps['ask'] =>
  async (_agent, addresses) => ({
    members: addresses.filter(members).map((address) => ({ address, consoleUserId: `user-${address}` })),
    outsiders: addresses.filter((address) => !members(address)),
    outsideSenders: 'refused'
  })
const corp = (address: string) => address.endsWith('@corp.example.test')

describe('the started thread’s tag (§6.4)', () => {
  it('is minted in the shape the relay checks, fresh each time', () => {
    const tags = new Set(Array.from({ length: 50 }, () => mintEmailStartedTag()))
    expect(tags.size).toBe(50)
    for (const tag of tags) expect(EMAIL_STARTED_TAG_PATTERN.test(tag), tag).toBe(true)
  })
})

describe('the recipient rules (§6.4)', () => {
  it('reads each address once, canonical, a Cc already in To dropped', () => {
    expect(startedRecipients({ to: [' Alice@Corp.Example.Test', ALICE], cc: [ALICE, BOB] }, AGENT)).toEqual({
      to: [ALICE],
      cc: [BOB]
    })
  })

  it('refuses more than fifty, the deployment’s own mail domain, and what is not an address', () => {
    const many = Array.from({ length: 51 }, (_, index) => `p${index}@corp.example.test`)
    expect(startedRecipients({ to: many }, AGENT)).toEqual({ refused: expect.stringContaining('at most 50') })
    expect(startedRecipients({ to: [ALICE], cc: ['other@mail.example.test'] }, AGENT)).toEqual({
      refused: expect.stringContaining('own mail domain')
    })
    expect(startedRecipients({ to: ['x@sub.mail.example.test'] }, AGENT)).toEqual({
      refused: expect.stringContaining('own mail domain')
    })
    expect(startedRecipients({ to: ['Alice <alice@corp.example.test>'] }, AGENT)).toEqual({
      refused: expect.stringContaining('not email addresses')
    })
  })
})

describe('who may cause a send (§6.4)', () => {
  const user = (id: string, extra: Partial<TurnMessage['msg']> = {}): TurnMessage => ({
    msg: { source: 'user', sender: { id, isBot: false }, platform: 'slack', ...extra } as TurnMessage['msg'],
    integrationId: 'int-slack'
  })
  const memberOf = async (asker: { userId: string }) =>
    asker.userId.startsWith('m-') ? `c-${asker.userId}` : undefined
  const judge = (messages: TurnMessage[] | undefined, delegated = false) =>
    memberTurnConsoleUsers({ messages, bot: 'int-slack', delegated, memberOf })

  it('names the members whose own messages alone started the turn, its own sender first', async () => {
    expect(await judge([user('m-1')])).toEqual(['c-m-1'])
    expect(await judge([user('m-1'), user('m-2'), user('m-1')])).toEqual(['c-m-1', 'c-m-2'])
  })

  it('fails closed on every other turn', async () => {
    // No live turn, a delegated task, a guest or an unlinked account, a folded message that is not a member’s own.
    expect(await judge(undefined)).toBeUndefined()
    expect(await judge([user('m-1')], true)).toBeUndefined()
    expect(await judge([user('guest')])).toBeUndefined()
    expect(await judge([user('m-1'), user('guest')])).toBeUndefined()
    // A schedule’s run, even one that records a person, a hook’s, another agent’s, a bot’s, and a sender with no identity.
    expect(await judge([{ ...user('m-1'), person: { kind: 'console', userId: 'c-m-1' } }])).toBeUndefined()
    expect(await judge([user('m-1', { source: 'cron' })])).toBeUndefined()
    expect(await judge([user('m-1', { source: 'hook' })])).toBeUndefined()
    expect(await judge([user('m-1', { source: 'agent' })])).toBeUndefined()
    expect(await judge([user('m-1', { sender: { id: 'm-1', isBot: true } })])).toBeUndefined()
    expect(await judge([user('', { sender: { id: '', isBot: false } })])).toBeUndefined()
    // A lookup that fails reads as not a member.
    const failing = await memberTurnConsoleUsers({
      messages: [user('m-1')],
      bot: 'int-slack',
      delegated: false,
      memberOf: async () => Promise.reject(new Error('down'))
    })
    expect(failing).toBeUndefined()
  })
})

describe('whose the started thread is (§5.3)', () => {
  const verdicts = new Map<string, EmailMemberVerdict>([
    [ALICE, { allowed: true, consoleUserId: 'user-alice' }],
    [BOB, { allowed: true, consoleUserId: 'user-bob' }],
    [STRANGER, { allowed: false, outsider: { admitted: false } }]
  ])

  it('one member recipient: that member’s own direct conversation', () => {
    expect(startedThreadPlace([BOB], TAG, verdicts, ['sender-1'])).toEqual({
      channel: `dm:${BOB}`,
      kind: 'dm',
      owner: BOB
    })
    expect(startedThreadPlace([BOB], TAG, verdicts, undefined)).toEqual({
      channel: `dm:${BOB}`,
      kind: 'dm',
      owner: BOB
    })
  })

  it('a non-member recipient or a group: private to the member whose turn sent it', () => {
    expect(startedThreadPlace([STRANGER], TAG, verdicts, ['sender-1'])).toEqual({
      channel: `dm:${STRANGER}`,
      kind: 'dm',
      owner: 'user:sender-1'
    })
    expect(startedThreadPlace([BOB, STRANGER], TAG, verdicts, ['sender-1', 'sender-2'])).toEqual({
      channel: `group:${TAG}`,
      kind: 'group_dm',
      owner: 'user:sender-1'
    })
  })

  it('a schedule’s or hook’s group thread: its first member recipient', () => {
    expect(startedThreadPlace([BOB, ALICE], TAG, verdicts, undefined)).toEqual({
      channel: `group:${TAG}`,
      kind: 'group_dm',
      owner: BOB
    })
  })
})

describe('sending and the record (§6.4)', () => {
  function harness(
    opts: {
      turn?: readonly string[]
      result?: EmailSendResult
      ask?: EmailMembersDeps['ask']
      attribution?: ReplyAttributionInfo
      sessionUrl?: string
    } = {}
  ) {
    const sends: WireEmailCall[] = []
    const rows: Record<string, unknown>[] = []
    const seeds: PlatformConversationSeed[] = []
    const conn: EmailStartDeps['conn'] = {
      address: AGENT,
      agentId: AGENT_ID,
      members: new EmailMembers({ ask: opts.ask ?? answer(corp), now: () => 0 }),
      send: async (call) => (sends.push(call), opts.result ?? { outcome: 'sent', messageId: 'p1@mail.example.test' }),
      recordSent: async (row) => (rows.push(row), true)
    }
    const deps: EmailStartDeps = {
      conn,
      env: {
        memberTurn: async () => opts.turn,
        startConversation: async (seed) => void seeds.push(seed),
        attribution: async () => opts.attribution,
        callingSessionUrl: async () => opts.sessionUrl
      },
      agentName: 'Helper',
      mintTag: () => TAG,
      now: () => 7
    }
    return { deps, sends, rows, seeds }
  }
  const args = { to: [STRANGER], cc: [BOB], subject: 'Plan', body: 'Hello **there**.' }

  it('mails anyone from a member’s turn, with no approval, and opens the thread with the mail as its first message', async () => {
    const h = harness({ turn: ['user-alice'] })
    // The member who asked is told where each answer lands, so recall reads them from here.
    expect(await startEmail(h.deps, args)).toEqual({
      sent: true,
      to: [STRANGER],
      cc: [BOB],
      replies: {
        toEveryone: `email:group:${TAG}`,
        toYouAlone: { [STRANGER]: `email:group:${TAG}>${STRANGER}`, [BOB]: `email:group:${TAG}>${BOB}` },
        note: expect.stringContaining('call recall with one of these places')
      }
    })
    expect(h.sends).toEqual([
      {
        op: 'start',
        tag: TAG,
        to: [STRANGER],
        cc: [BOB],
        fromName: 'Helper',
        subject: 'Plan',
        text: 'Hello **there**.',
        html: '<p>Hello <strong>there</strong>.</p>'
      }
    ])
    expect(h.rows).toEqual([
      {
        messageId: 'p1@mail.example.test',
        thread: TAG,
        conversation: `group:${TAG}`,
        mail: JSON.stringify({
          from: { address: AGENT, name: 'Helper' },
          to: [{ address: STRANGER }],
          cc: [{ address: BOB }],
          subject: 'Plan',
          started: true,
          owner: 'user:user-alice'
        }),
        ts: TAG,
        outcome: 'sent',
        createdAt: 7
      }
    ])
    expect(h.seeds).toEqual([
      { channel: `group:${TAG}`, kind: 'group_dm', owner: 'user:user-alice', thread: TAG, text: 'Hello **there**.' }
    ])
  })

  it('puts the agent’s footer under a mail to members only, and keeps the thread’s first record without it', async () => {
    const attribution = {
      botName: 'Helper',
      botUrl: 'https://console.example.test/agents/a1',
      runtime: 'Claude Code',
      model: 'opus',
      sessionUrl: 'https://console.example.test/sessions/s1'
    }
    const members = harness({ turn: ['user-alice'], attribution })
    await startEmail(members.deps, { to: [BOB], subject: 'Plan', body: 'Hello.' })
    expect(members.sends[0]!.text).toBe(
      'Hello.\n\n---\n\nsent by [Helper](https://console.example.test/agents/a1) (Claude Code · opus) · ' +
        '[open in session](https://console.example.test/sessions/s1)'
    )
    expect(members.seeds[0]!.text).toBe('Hello.')
    // A mail that reaches anyone outside the organization carries no footer at all.
    const outside = harness({ turn: ['user-alice'], attribution })
    await startEmail(outside.deps, args)
    expect(outside.sends[0]!.text).toBe('Hello **there**.')
  })

  it('keeps, unmailed under the thread’s first record, the conversation that asked and the agent’s purpose', async () => {
    const h = harness({ turn: ['user-alice'], sessionUrl: 'https://console.example.test/sessions/s9' })
    await startEmail(h.deps, {
      to: [BOB],
      subject: 'Colour',
      body: 'Your favourite colour?',
      purpose: 'Dana asked me to find out.'
    })
    expect(h.sends[0]!.text).toBe('Your favourite colour?')
    expect(h.seeds[0]!.text).toBe(
      'Your favourite colour?\n\n---\n\nNot mailed. Sent from [this conversation](https://console.example.test/sessions/s9). ' +
        'Purpose: Dana asked me to find out.'
    )
    expect(emailOriginNote(undefined, undefined)).toBeUndefined()
  })

  it('mails members only from any other turn, and refuses an outside recipient there saying why', async () => {
    const h = harness({ turn: undefined })
    await expect(startEmail(h.deps, args)).rejects.toThrow(
      /not started by a member’s own message.*stranger@other\.example\.test\. Nothing was sent\./
    )
    expect(h.sends).toEqual([])
    expect(h.rows).toEqual([])
    // Members alone go out, a schedule’s group thread owned by its first member recipient, with nobody to recall it.
    const scheduled = await startEmail(h.deps, { to: [BOB, ALICE], subject: 'Plan', body: 'Hi' })
    expect(scheduled).toMatchObject({ sent: true })
    expect(scheduled).not.toHaveProperty('replies')
    expect(h.seeds[0]).toMatchObject({ channel: `group:${TAG}`, owner: BOB })
  })

  it('refuses when the member question cannot be asked, whoever is asking', async () => {
    const h = harness({ turn: ['user-alice'], ask: async () => undefined })
    await expect(startEmail(h.deps, args)).rejects.toThrow(/could not be checked now/)
    expect(h.sends).toEqual([])
  })

  it('records nothing for a mail the relay never sent, and keeps the thread of one that may have landed', async () => {
    const unsent = harness({
      turn: ['user-alice'],
      result: { outcome: 'unsent', reason: 'the relay refused it (budget_outside_bot)' }
    })
    await expect(startEmail(unsent.deps, args)).rejects.toThrow(/budget_outside_bot.*Nothing was sent/)
    expect(unsent.rows).toEqual([])
    expect(unsent.seeds).toEqual([])
    const unknown = harness({ turn: ['user-alice'], result: { outcome: 'unknown', reason: 'no answer' } })
    expect(await startEmail(unknown.deps, args)).toMatchObject({
      sent: false,
      note: expect.stringContaining('may not')
    })
    expect(unknown.rows[0]).toMatchObject({ thread: TAG, outcome: 'unknown', reason: 'no answer' })
    expect(unknown.rows[0]).not.toHaveProperty('messageId')
    expect(unknown.seeds).toHaveLength(1)
  })

  it('is one tool of the email module, offered with an instruction line naming the address', () => {
    const integration = {
      id: 'int-email',
      platform: 'email',
      config: { address: AGENT, egress: 'relay', botId: AGENT_ID }
    }
    expect(agentToolsFor(['email']).map((tool) => tool.name)).toEqual(['sendEmail'])
    expect(agentToolsFor(['slack'])).toEqual([])
    expect(ALL_TOOL_NAMES).toContain('sendEmail')
    // Offered in a session on another platform too, as long as the agent holds the address.
    const tools = toolsForIntegrations([integration, { id: 'int-slack', platform: 'slack' }] as never, {
      currentPlatform: 'slack'
    })
    expect(tools.map((tool) => tool.name)).toContain('sendEmail')
    expect(agentToolInstructions([integration] as never, tools)).toEqual([
      expect.stringContaining(`Your email address is ${AGENT}.`)
    ])
    expect(agentToolInstructions([integration] as never, [])).toEqual([])
    expect(EMAIL_AGENT_TOOLS.instructions({ id: 'x', platform: 'email', config: {} } as never)).toEqual([])
  })
})

describe('the dispatch of an agent tool (read-ports.ts agentTools)', () => {
  const ctx = {
    agentId: AGENT_ID,
    agentName: 'Helper',
    platform: 'webchat',
    isDm: true,
    channel: 'conv-1',
    thread: 'conv-1',
    deliveryThread: 'conv-1',
    tools: [],
    integrations: [{ id: 'int-email', platform: 'email' }]
  } as unknown as SessionContext

  it('acts through the agent’s own integration of that platform from a session on another, asking core who started the turn', async () => {
    const sends: WireEmailCall[] = []
    const conn = {
      address: AGENT,
      agentId: AGENT_ID,
      members: new EmailMembers({ ask: answer(corp), now: () => 0 }),
      startedThread: async () => undefined,
      send: async (call: WireEmailCall) => (sends.push(call), { outcome: 'sent' as const }),
      recordSent: async () => true
    }
    const memberTurnFor = vi.fn(async () => ['user-alice'])
    const startAgentConversation = vi.fn(async () => {})
    const deps = {
      gatewayFor: () => undefined,
      sessionToolConnectionFor: (id: string) => (id === 'int-email' ? conn : undefined),
      memberTurnFor,
      startAgentConversation
    } as unknown as OpsDeps
    const result = await executeTool(ctx, 'sendEmail', { to: [STRANGER], subject: 'Plan', body: 'Hi' }, deps)
    expect(result).toMatchObject({ sent: true, to: [STRANGER] })
    expect(sends[0]).toMatchObject({ op: 'start', to: [STRANGER], fromName: 'Helper' })
    expect(memberTurnFor).toHaveBeenCalledWith(ctx)
    expect(startAgentConversation).toHaveBeenCalledWith(ctx, 'int-email', expect.objectContaining({ kind: 'dm' }))
    // Without the core hook the who-may-cause rule fails closed: members only.
    const closed = { ...deps, memberTurnFor: undefined } as unknown as OpsDeps
    await expect(
      executeTool(ctx, 'sendEmail', { to: [STRANGER], subject: 'Plan', body: 'Hi' }, closed)
    ).rejects.toThrow(/members of your organization only/)
    await expect(
      executeTool(
        { ...ctx, integrations: [] } as unknown as SessionContext,
        'sendEmail',
        { to: [ALICE], subject: 'x', body: 'y' },
        deps
      )
    ).rejects.toThrow('sendEmail: this agent has no Email integration')
  })
})

describe('a reply finds its started thread (§5.1, §5.2)', () => {
  function mail(over: Partial<WireEmailAdapterExt> = {}): WireEmailAdapterExt {
    return {
      from: { address: BOB },
      to: [{ address: `helper+${TAG}@mail.example.test` }],
      cc: [],
      subject: 'Re: Plan',
      messageId: 'r1@corp.example.test',
      references: [],
      attachments: [],
      tag: TAG,
      ...over
    }
  }
  const started: EmailStartedThread = {
    thread: TAG,
    conversation: `group:${TAG}`,
    recipients: [STRANGER, BOB],
    members: [STRANGER, BOB]
  }
  const index = (
    thread: EmailStartedThread | null = started,
    known: Record<string, string> = {}
  ): EmailPlacementIndex => ({
    message: async (id) =>
      known[id] ? { thread: known[id], conversation: thread?.conversation ?? `dm:${BOB}` } : undefined,
    conversation: async () => undefined,
    startedThread: async (tag) => (tag === TAG && thread ? thread : undefined)
  })

  it('places a reply every current member is on in the started thread, whatever headers it names', async () => {
    const all = mail({ cc: [{ address: STRANGER }] })
    expect(await placeEmail(all, AGENT, index())).toEqual({
      thread: TAG,
      conversation: { kind: 'group', channel: `group:${TAG}` },
      redelivered: false,
      started: { tag: TAG, recipients: [STRANGER, BOB], own: false }
    })
    // The tag wins over headers that name another thread.
    const elsewhere = await placeEmail(
      { ...all, references: ['other@x'] },
      AGENT,
      index(started, { 'other@x': 'other@x' })
    )
    expect(elsewhere.thread).toBe(TAG)
  })

  it('places a recipient’s plain Reply, which leaves the others off, in a thread and conversation of their own', async () => {
    expect(await placeEmail(mail(), AGENT, index({ ...started, owner: 'user:user-alice' }))).toEqual({
      thread: `${TAG}>${BOB}`,
      conversation: { kind: 'group', channel: `group:${TAG}>${BOB}` },
      redelivered: false,
      started: { tag: TAG, recipients: [STRANGER, BOB], own: true, owner: 'user:user-alice' }
    })
    // Never the recipient's direct conversation, whether they copy someone the started mail never went to or not.
    const copied = await placeEmail(mail({ cc: [{ address: PAT }] }), AGENT, index())
    expect(copied).toMatchObject({
      thread: `${TAG}>${BOB}`,
      conversation: { kind: 'group', channel: `group:${TAG}>${BOB}` },
      started: { own: true }
    })
  })

  it('continues a recipient’s own thread from a reply to the agent’s answer, which carries no tag', async () => {
    const own = emailStartedReplyThread(TAG, STRANGER)
    const answers: EmailPlacementIndex = {
      message: async (id) =>
        id === 'a1@mail.example.test' ? { thread: own, conversation: `group:${own}` } : undefined,
      conversation: async (channel) =>
        channel === `group:${own}` ? { opener: STRANGER, members: [STRANGER] } : undefined,
      startedThread: async (tag) => (tag === TAG ? started : undefined)
    }
    const followUp = mail({ from: { address: STRANGER }, tag: undefined, inReplyTo: 'a1@mail.example.test' })
    expect(await placeEmail(followUp, AGENT, answers)).toEqual({
      thread: own,
      conversation: { kind: 'group', channel: `group:${own}` },
      redelivered: false,
      started: { tag: TAG, recipients: [STRANGER, BOB], own: true }
    })
  })

  it('names a recipient’s own thread by a key no mail can carry as its Message-ID', () => {
    const own = emailStartedReplyThread(TAG, BOB)
    expect(EMAIL_MESSAGE_ID_PATTERN.test(own)).toBe(false)
    expect(emailStartedTagOf(own)).toBe(TAG)
    expect(emailStartedTagOf(TAG)).toBe(TAG)
    for (const other of [`${TAG}>`, 'r1@corp.example.test', `${TAG}x>${BOB}`])
      expect(emailStartedTagOf(other)).toBeUndefined()
  })

  it('keeps the sender check: someone the thread never named starts a thread of its own', async () => {
    const placed = await placeEmail(mail({ from: { address: PAT } }), AGENT, index())
    expect(placed).toEqual({
      thread: 'r1@corp.example.test',
      conversation: { kind: 'dm', channel: `dm:${PAT}` },
      redelivered: false
    })
  })

  it('places a reply that names the started mail by its ID as its tag would, and ignores a tag never minted', async () => {
    const byId = await placeEmail(
      mail({ tag: undefined, inReplyTo: 'p1@mail.example.test' }),
      AGENT,
      index(started, { 'p1@mail.example.test': TAG })
    )
    expect(byId.started).toBeDefined()
    const unknown = await placeEmail(mail(), AGENT, index(null))
    expect(unknown).toMatchObject({ thread: 'r1@corp.example.test' })
    expect(unknown.started).toBeUndefined()
  })
})

describe('admitting a reply to a started thread under Members (§4 step 3, §5.3)', () => {
  function admitWith(
    thread: EmailStartedThread | undefined,
    answers = { together: new Set<string>(), alone: new Set<string>() }
  ) {
    const conn = {
      address: AGENT,
      message: async () => undefined,
      conversation: async () => undefined,
      startedThread: async (tag: string) => (tag === TAG ? thread : undefined),
      threadSenders: async () => new Set<string>(),
      latestReceived: async () => undefined,
      startedMail: async () => '[From: helper@mail.example.test]\n\nHere is the plan.',
      startedAnswers: async () => answers
    } as unknown as EmailConnection
    const placeExternal = vi.fn()
    const strategy = emailRelayIngress({
      connection: () => conn,
      members: new EmailMembers({ ask: answer(corp), now: () => 0 }),
      placeExternal,
      whoMayWrite: () => 'members',
      store: () => ({ emailMessages: { record: vi.fn(async () => true) } as never }),
      now: () => 5,
      warn: () => {}
    })
    return { strategy, placeExternal }
  }
  const delivery = (ext: WireEmailAdapterExt) => {
    const normalized = {
      msgId: `email:${AGENT}:${ext.messageId}`,
      platform: 'email',
      channel: `dm:${ext.from.address}`,
      thread: ext.messageId,
      sender: { id: ext.from.address, isBot: false },
      text: 'Sounds good.',
      mentionedBots: [],
      isDm: true,
      source: 'user',
      adapterExt: { email: ext }
    } as unknown as NormalizedMessage
    return { msg: { msgId: normalized.msgId, agentId: AGENT_ID, integrationId: 'int-email' } as RdMsgIm, normalized }
  }
  const reply = (from: string, over: Partial<WireEmailAdapterExt> = {}): WireEmailAdapterExt => ({
    from: { address: from },
    to: [{ address: `helper+${TAG}@mail.example.test` }],
    cc: [{ address: BOB }],
    subject: 'Re: Plan',
    messageId: `${from}-r1`,
    references: [],
    attachments: [],
    tag: TAG,
    ...over
  })
  const started: EmailStartedThread = {
    thread: TAG,
    conversation: `group:${TAG}`,
    recipients: [STRANGER, BOB],
    members: [STRANGER, BOB]
  }

  it('admits a non-member the started mail went to into that thread, marked outside, the thread external', async () => {
    const h = admitWith(started)
    const one = delivery(reply(STRANGER))
    expect(await h.strategy.admit!(one.msg, one.normalized)).toBe('admit')
    expect(one.normalized).toMatchObject({
      channel: `group:${TAG}`,
      thread: TAG,
      isGroupDm: true,
      threadRootIsOwn: true
    })
    expect((one.normalized.adapterExt!.email as WireEmailAdapterExt).outsider).toBe(true)
    expect(h.placeExternal).toHaveBeenCalledWith(['int-email'], `group:${TAG}`, 'externalMember')
  })

  it('refuses a non-member the started mail never went to, and one that answers no mail', async () => {
    const h = admitWith({ ...started, members: [STRANGER, BOB, PAT] })
    const notSent = delivery(reply(PAT))
    expect(await h.strategy.admit!(notSent.msg, notSent.normalized)).toBe('rejected')
    const untagged = delivery(reply(STRANGER, { tag: undefined }))
    expect(await admitWith(started).strategy.admit!(untagged.msg, untagged.normalized)).toBe('rejected')
  })

  it('admits a non-member’s plain Reply into their own thread, for the member who asked, with the started mail read first', async () => {
    const h = admitWith({ ...started, owner: 'user:user-alice' }, { together: new Set(), alone: new Set() })
    const plain = delivery(reply(STRANGER, { cc: [] }))
    expect(await h.strategy.admit!(plain.msg, plain.normalized)).toBe('admit')
    expect(plain.normalized).toMatchObject({
      channel: `group:${TAG}>${STRANGER}`,
      thread: `${TAG}>${STRANGER}`,
      isGroupDm: true,
      sessionTriggerId: 'user:user-alice'
    })
    expect(plain.normalized.threadRootIsOwn).toBeUndefined()
    expect((plain.normalized.adapterExt!.email as WireEmailAdapterExt).outsider).toBe(true)
    expect(h.placeExternal).toHaveBeenCalledWith(['int-email'], `group:${TAG}>${STRANGER}`, 'externalMember')
    expect(plain.normalized.text).toContain('continues in a thread of its own')
    expect(plain.normalized.text).toContain('the member who asked for the mail can read it')
    expect(plain.normalized.text).toContain('Here is the plan.')
    expect(plain.normalized.text).toContain(`Not answered your started mail yet: ${BOB}.`)
  })

  it('gives a member’s own thread to the member who asked too, and tells the started thread who answered alone', async () => {
    const member = admitWith({ ...started, owner: 'user:user-alice' })
    const own = delivery(reply(BOB, { cc: [] }))
    expect(await member.strategy.admit!(own.msg, own.normalized)).toBe('admit')
    expect(own.normalized).toMatchObject({
      channel: `group:${TAG}>${BOB}`,
      thread: `${TAG}>${BOB}`,
      sessionTriggerId: 'user:user-alice'
    })
    // With nobody who asked, a member's own thread stays theirs.
    const scheduled = admitWith({ ...started, owner: BOB })
    const theirs = delivery(reply(BOB, { cc: [], messageId: 'bob-r2' }))
    expect(await scheduled.strategy.admit!(theirs.msg, theirs.normalized)).toBe('admit')
    expect(theirs.normalized.sessionTriggerId).toBeUndefined()
    expect(theirs.normalized.text).toContain('none of the others sees this thread')
    const shared = admitWith(started, { together: new Set(), alone: new Set([STRANGER]) })
    const all = delivery(reply(BOB, { cc: [{ address: STRANGER }] }))
    expect(await shared.strategy.admit!(all.msg, all.normalized)).toBe('admit')
    expect(all.normalized.thread).toBe(TAG)
    expect(all.normalized.text).toContain(`${STRANGER} answered your started mail leaving the others off`)
    expect(all.normalized.text).not.toContain('Here is the plan.')
  })

  it('says nothing of the others once everyone has answered with everyone on it', () => {
    const notes = emailStartedNotes({
      sender: BOB,
      recipients: [STRANGER, BOB],
      answers: { together: new Set([STRANGER]), alone: new Set() }
    })
    expect(notes).toEqual([])
  })

  it('copies on the reply a non-member the started mail went to, and never one who only appears on a header', async () => {
    const members = new EmailMembers({ ask: answer(corp), now: () => 0 })
    const answered = reply(BOB, { cc: [{ address: STRANGER }, { address: PAT }] })
    const audience = await emailReplyAudience(
      members,
      AGENT_ID,
      answered,
      AGENT,
      true,
      async () => new Set<string>(),
      new Set([STRANGER, BOB])
    )
    expect(audience).toMatchObject({ to: [BOB], cc: [STRANGER], leftOff: [PAT], outside: true })
  })
})

describe('the started thread through the daemon (§6.4)', () => {
  const AGENT_NAME = 'mail-bot'
  const INTEGRATION = 'int-email'
  const BOT = '8f0a1c62-9a0f-4c6e-8b2b-7d3f5a1c0002'

  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-email-started-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const adir = join(root, 'agents', AGENT_NAME)
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: AGENT_NAME,
        name: AGENT_NAME,
        displayName: 'Mail Bot',
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        integrations: [
          {
            id: INTEGRATION,
            platform: 'email',
            core: { mode: 'shared', bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'mention' } }] },
            config: { address: AGENT, egress: 'relay', botId: BOT }
          }
        ],
        output: { mode: 'low' }
      })
    )
    return root
  }

  it('opens the started thread’s session for its owner, a stranger’s plain Reply a thread of their own for that owner, and a Reply All the started thread', async () => {
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(),
      stop: vi.fn()
    }
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => host as any })
    await daemon.start()
    await (daemon as any).connections.reconcileEmailConnections()
    ;(daemon as any).cpClient = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (prop === 'supportsServerFeature') return (feature: string) => feature === EMAIL_MEMBERS_V1_FEATURE
        if (prop === 'emailMembers')
          return async ({ addresses }: { addresses: string[] }) => answer(corp)('', addresses)
        return () => undefined
      }
    })
    const turns: Promise<unknown>[] = []
    const realDispatch = (daemon as any).dispatch.bind(daemon)
    ;(daemon as any).dispatch = (...args: unknown[]) => {
      const settled = realDispatch(...args)
      turns.push(Promise.resolve(settled).catch(() => undefined))
      return settled
    }
    const settled = async () => {
      while (turns.length) await turns.shift()
    }
    const store = (daemon as any).store
    const conn = (daemon as any).emailConnByIntegration.get(INTEGRATION) as EmailConnection
    expect(conn.members).toBeDefined()
    // What the tool does once the relay answers: the index row, then the session.
    const mail = JSON.stringify({
      from: { address: AGENT },
      to: [{ address: STRANGER }],
      cc: [{ address: BOB }],
      subject: 'Plan',
      started: true,
      owner: 'user:user-alice'
    })
    await conn.recordSent({ thread: TAG, conversation: `group:${TAG}`, mail, ts: TAG, outcome: 'sent', createdAt: 1 })
    await (daemon as any).startAgentConversation({ agentId: AGENT_NAME }, INTEGRATION, {
      channel: `group:${TAG}`,
      thread: TAG,
      kind: 'group_dm',
      text: 'Here is the plan.',
      owner: 'user:user-alice'
    })
    await settled()
    const sessions = (await store.listSessions(AGENT_NAME)).filter((s: { platform: string }) => s.platform === 'email')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      channel: `group:${TAG}`,
      thread: TAG,
      conversationKind: 'group_dm',
      triggeredBy: 'user:user-alice'
    })
    expect(host.prompt).not.toHaveBeenCalled()
    const scope = (daemon as any).transportScopeForIntegrationIds([INTEGRATION])
    const rows = await store.admittedTextRowsByTs(AGENT_NAME, transcriptChannelKey(`group:${TAG}`, scope), [TAG])
    expect(rows[0]).toMatchObject({ sender: AGENT_NAME, text: 'Here is the plan.' })
    // The history read serves the started mail like any sent one.
    const history = await conn.getThreadReplies(`group:${TAG}`, TAG)
    expect(history[0]).toMatchObject({ isBot: true, text: expect.stringContaining('Here is the plan.') })

    const ext: WireEmailAdapterExt = {
      from: { address: STRANGER },
      to: [{ address: `helper+${TAG}@mail.example.test` }],
      cc: [],
      subject: 'Re: Plan',
      messageId: 'r1@other.example.test',
      references: [],
      attachments: [],
      ticket: 'e1.cjE.1700000000000.bWFj',
      tag: TAG
    }
    const deliver = async (mail: WireEmailAdapterExt, text: string) => {
      const id = `email:${AGENT}:${mail.messageId}`
      const from = mail.from.address
      return await (daemon as any).handleRelayIm({
        source: 'im',
        agentId: AGENT_NAME,
        botId: BOT,
        integrationId: INTEGRATION,
        sessionKey: `dm:${from}`,
        msgId: id,
        payload: {
          msgId: id,
          traceId: id,
          source: 'user',
          platform: 'email',
          channel: `dm:${from}`,
          thread: mail.messageId,
          sender: { id: from, isBot: false },
          text,
          mentionedBots: [],
          isDm: true,
          trigger: 'dm',
          adapterExt: { email: mail }
        }
      })
    }
    expect(await deliver(ext, 'Looks good to me.')).toMatchObject({ accepted: true, routeAdmission: 'admitted' })
    await settled()
    expect(await store.emailMessages.get(AGENT, 'r1@other.example.test')).toMatchObject({
      thread: `${TAG}>${STRANGER}`,
      conversation: `group:${TAG}>${STRANGER}`,
      direction: 'received'
    })
    const own = (await store.listSessions(AGENT_NAME)).filter(
      (s: { platform: string; thread: string }) => s.platform === 'email' && s.thread === `${TAG}>${STRANGER}`
    )
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({
      channel: `group:${TAG}>${STRANGER}`,
      conversationKind: 'group_dm',
      triggeredBy: 'user:user-alice'
    })
    // Its first turn reads the started mail before the reply.
    const prompted = JSON.stringify(host.prompt.mock.calls.at(-1))
    expect(prompted).toContain('Here is the plan.')
    expect(prompted).toContain('Looks good to me.')

    // A Reply All from the other recipient continues the started thread, which learns only that the stranger answered alone.
    const all: WireEmailAdapterExt = {
      ...ext,
      from: { address: BOB },
      cc: [{ address: STRANGER }],
      messageId: 'r2@corp.example.test'
    }
    expect(await deliver(all, 'Tuesday works for me.')).toMatchObject({ accepted: true, routeAdmission: 'admitted' })
    await settled()
    expect(await store.emailMessages.get(AGENT, 'r2@corp.example.test')).toMatchObject({
      thread: TAG,
      conversation: `group:${TAG}`
    })
    const sharedPrompt = JSON.stringify(host.prompt.mock.calls.at(-1))
    expect(sharedPrompt).toContain('Tuesday works for me.')
    expect(sharedPrompt).toContain(`${STRANGER} answered your started mail leaving the others off`)
    expect(sharedPrompt).not.toContain('Looks good to me.')
    const sessions2 = (await store.listSessions(AGENT_NAME)).filter((s: { platform: string }) => s.platform === 'email')
    expect(sessions2).toHaveLength(2)
    await daemon.stop()
  })
})
