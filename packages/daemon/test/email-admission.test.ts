// Where an admitted mail goes and who may write (email-integration.md §4 step 3, §5.1, §5.2, §5.4): placement, the fence, the member question and the prompt.
import { describe, expect, it, vi } from 'vitest'
import { EMAIL_MEMBERS_MAX, type RdMsgIm, type WireEmailAdapterExt } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { EmailConnection } from '../src/platforms/email/connection.js'
import {
  EMAIL_MEMBER_ALLOW_TTL_MS,
  EMAIL_MEMBER_DENY_TTL_MS,
  EmailMembers,
  type EmailMembersDeps
} from '../src/platforms/email/members.js'
import { emailPrompt, emailRelayIngress } from '../src/platforms/email/module.js'
import {
  placeEmail,
  type EmailConversationState,
  type EmailKnownMessage,
  type EmailPlacementIndex
} from '../src/platforms/email/threading.js'

const AGENT = 'helper@mail.example.test'
const AGENT_ID = '00000000-0000-4000-8000-0000000000a1'
const ALICE = 'alice@corp.example.test'
const BOB = 'bob@corp.example.test'
const MALLORY = 'mallory@corp.example.test'
const STRANGER = 'stranger@other.example.test'

// The Control Plane's answer: these members, and every other asked address read as one no member holds when `outside` says so.
const answer =
  (members: (address: string) => boolean, outside?: 'admitted' | 'refused'): EmailMembersDeps['ask'] =>
  async (_agent, addresses) => ({
    members: addresses.filter(members).map((address) => ({ address, consoleUserId: `user-${address}` })),
    ...(outside
      ? { outsiders: addresses.filter((address) => !members(address)), outsideSenders: outside }
      : { outsiders: [] })
  })

function mail(over: Partial<WireEmailAdapterExt> = {}): WireEmailAdapterExt {
  return {
    from: { address: ALICE },
    to: [{ address: AGENT }],
    cc: [],
    subject: 'Plan',
    messageId: 'new@corp.example.test',
    references: [],
    attachments: [],
    ...over
  }
}

// The index as placement reads it: known messages and each group's opener and current members.
function index(
  messages: Record<string, EmailKnownMessage>,
  groups: Record<string, EmailConversationState> = {}
): EmailPlacementIndex {
  return {
    message: async (id) => messages[id],
    conversation: async (channel) => groups[channel]
  }
}

describe('placement (§5.1, §5.2)', () => {
  it('starts a member’s own thread in their direct conversation, keyed by the mail itself', async () => {
    const placed = await placeEmail(mail(), AGENT, index({}))
    expect(placed).toEqual({
      thread: 'new@corp.example.test',
      conversation: { kind: 'dm', channel: `dm:${ALICE}` },
      redelivered: false
    })
  })

  it('takes the thread of the nearest known message, newest reference first, then In-Reply-To', async () => {
    const known = index({
      'root@x': { thread: 'root@x', conversation: `dm:${ALICE}` },
      'split@x': { thread: 'split@x', conversation: `dm:${ALICE}` }
    })
    const placed = await placeEmail(mail({ references: ['root@x', 'split@x', 'unknown@x'] }), AGENT, known)
    expect(placed.thread).toBe('split@x')
    const viaReply = await placeEmail(mail({ inReplyTo: 'root@x' }), AGENT, known)
    expect(viaReply.thread).toBe('root@x')
  })

  it('falls back on the header-only key when no named message is known', async () => {
    const placed = await placeEmail(
      mail({ references: ['first@x', 'second@x'], inReplyTo: 'second@x' }),
      AGENT,
      index({})
    )
    expect(placed.thread).toBe('first@x')
    expect((await placeEmail(mail({ inReplyTo: 'only@x' }), AGENT, index({}))).thread).toBe('only@x')
  })

  it('places a redelivered mail where it already is', async () => {
    const placed = await placeEmail(
      mail({ cc: [{ address: BOB }] }),
      AGENT,
      index({ 'new@corp.example.test': { thread: 't9', conversation: 'group:t9' } })
    )
    expect(placed).toEqual({ thread: 't9', conversation: { kind: 'group', channel: 'group:t9' }, redelivered: true })
  })

  it('makes a member’s thread that names someone else a group, and one that drops them direct again', async () => {
    const known = index({ 'root@x': { thread: 'root@x', conversation: `dm:${ALICE}` } })
    const group = await placeEmail(mail({ references: ['root@x'], cc: [{ address: BOB }] }), AGENT, known)
    expect(group.conversation).toEqual({ kind: 'group', channel: 'group:root@x' })
    const back = await placeEmail(
      mail({ references: ['root@x'] }),
      AGENT,
      index(
        { 'root@x': { thread: 'root@x', conversation: 'group:root@x' } },
        { 'group:root@x': { opener: ALICE, members: [ALICE, BOB] } }
      )
    )
    expect(back.conversation).toEqual({ kind: 'dm', channel: `dm:${ALICE}` })
  })

  it('counts an unreadable recipient as someone the mail went to', async () => {
    const placed = await placeEmail(mail({ unreadableRecipients: 1 }), AGENT, index({}))
    expect(placed.conversation.kind).toBe('group')
  })

  describe('the participant fence', () => {
    const thread = index(
      { 'root@x': { thread: 'root@x', conversation: 'group:root@x' } },
      { 'group:root@x': { opener: ALICE, members: [ALICE, BOB] } }
    )

    it('continues a group for a current member who keeps the opener on', async () => {
      const placed = await placeEmail(
        mail({ from: { address: BOB }, references: ['root@x'], cc: [{ address: ALICE }] }),
        AGENT,
        thread
      )
      expect(placed.thread).toBe('root@x')
    })

    it('starts a thread of its own for a sender the thread never named', async () => {
      const placed = await placeEmail(
        mail({ from: { address: MALLORY }, references: ['root@x'], cc: [{ address: ALICE }] }),
        AGENT,
        thread
      )
      expect(placed).toEqual({
        thread: 'new@corp.example.test',
        conversation: { kind: 'group', channel: 'group:new@corp.example.test' },
        redelivered: false
      })
    })

    it('starts a thread of its own for a mail that leaves the opener off', async () => {
      const placed = await placeEmail(
        mail({ from: { address: BOB }, references: ['root@x'], cc: [{ address: MALLORY }] }),
        AGENT,
        thread
      )
      expect(placed.thread).toBe('new@corp.example.test')
    })

    it('fences a forged header that names only the fallback key', async () => {
      const placed = await placeEmail(
        mail({ from: { address: MALLORY }, references: ['root@x'], cc: [{ address: ALICE }] }),
        AGENT,
        index({}, { 'group:root@x': { opener: ALICE, members: [ALICE, BOB] } })
      )
      expect(placed.thread).toBe('new@corp.example.test')
    })

    it('never opens a group onto a thread of someone else’s direct conversation', async () => {
      const placed = await placeEmail(
        mail({ from: { address: MALLORY }, references: ['root@x'], cc: [{ address: ALICE }] }),
        AGENT,
        index({ 'root@x': { thread: 'root@x', conversation: `dm:${ALICE}` } })
      )
      expect(placed.thread).toBe('new@corp.example.test')
    })

    it('reaches a split-off thread from a reply to it, not the thread it left', async () => {
      const placed = await placeEmail(
        mail({ from: { address: MALLORY }, references: ['root@x', 'split@x'], cc: [{ address: ALICE }] }),
        AGENT,
        index(
          {
            'root@x': { thread: 'root@x', conversation: 'group:root@x' },
            'split@x': { thread: 'split@x', conversation: 'group:split@x' }
          },
          {
            'group:root@x': { opener: ALICE, members: [ALICE, BOB] },
            'group:split@x': { opener: MALLORY, members: [MALLORY, ALICE] }
          }
        )
      )
      expect(placed.thread).toBe('split@x')
    })
  })
})

describe('the member question (§4 step 3)', () => {
  function members(answer: EmailMembersDeps['ask']) {
    let now = 1_000
    const ask = vi.fn(answer)
    return { members: new EmailMembers({ ask, now: () => now }), ask, tick: (ms: number) => (now += ms) }
  }

  it('reuses an allowed answer for two minutes and a refusal for thirty seconds', async () => {
    const { members: m, ask, tick } = members(answer((a) => a === ALICE))
    const first = await m.judge(AGENT_ID, [ALICE, BOB])
    expect(first?.get(ALICE)).toEqual({ allowed: true, consoleUserId: `user-${ALICE}` })
    expect(first?.get(BOB)).toEqual({ allowed: false })
    expect(ask).toHaveBeenCalledTimes(1)
    tick(EMAIL_MEMBER_DENY_TTL_MS)
    await m.judge(AGENT_ID, [ALICE, BOB])
    expect(ask).toHaveBeenLastCalledWith(AGENT_ID, [BOB])
    tick(EMAIL_MEMBER_ALLOW_TTL_MS)
    await m.judge(AGENT_ID, [ALICE])
    expect(ask).toHaveBeenLastCalledWith(AGENT_ID, [ALICE])
    expect(await m.consoleUser(AGENT_ID, ALICE)).toBe(`user-${ALICE}`)
  })

  it('tells an address no member holds from a refused one, and reuses an admitted outsider like a member', async () => {
    const {
      members: m,
      ask,
      tick
    } = members(async (_agent, addresses) => ({
      members: [],
      outsiders: addresses.filter((a) => a === STRANGER),
      outsideSenders: 'admitted'
    }))
    const first = await m.judge(AGENT_ID, [STRANGER, BOB])
    expect(first?.get(STRANGER)).toEqual({ allowed: false, outsider: { admitted: true } })
    expect(first?.get(BOB)).toEqual({ allowed: false })
    tick(EMAIL_MEMBER_DENY_TTL_MS)
    await m.judge(AGENT_ID, [STRANGER, BOB])
    expect(ask).toHaveBeenLastCalledWith(AGENT_ID, [BOB])
    // An older Control Plane names no outsider: everyone it leaves out is refused.
    const older = members(async () => ({ members: [] }))
    expect((await older.members.judge(AGENT_ID, [STRANGER]))?.get(STRANGER)).toEqual({ allowed: false })
  })

  it('admits nobody when it cannot be asked, and caches nothing then', async () => {
    const { members: m, ask } = members(async () => undefined)
    expect(await m.judge(AGENT_ID, [ALICE])).toBeUndefined()
    await expect(m.consoleUser(AGENT_ID, ALICE)).rejects.toThrow()
    const throwing = members(async () => {
      throw new Error('INTERNAL')
    })
    expect(await throwing.members.judge(AGENT_ID, [ALICE])).toBeUndefined()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('asks in batches no larger than the frame allows', async () => {
    const { members: m, ask } = members(answer(() => false))
    const many = Array.from({ length: EMAIL_MEMBERS_MAX + 3 }, (_, i) => `p${i}@corp.example.test`)
    await m.judge(AGENT_ID, many)
    expect(ask.mock.calls.map(([, addresses]) => addresses.length)).toEqual([EMAIL_MEMBERS_MAX, 3])
  })
})

describe('admission on the relay path', () => {
  function admitWith(
    ask: EmailMembersDeps['ask'],
    opts: { known?: EmailPlacementIndex; whoMayWrite?: 'members' | 'anyone'; wrote?: string[] } = {}
  ) {
    const conn = {
      address: AGENT,
      ...(opts.known ?? index({})),
      threadSenders: async () => new Set(opts.wrote ?? [])
    } as unknown as EmailConnection
    const members = new EmailMembers({ ask, now: () => 0 })
    const record = vi.fn(async () => true)
    const placeExternal = vi.fn()
    const strategy = emailRelayIngress({
      connection: (id) => (id === 'int-email' ? conn : undefined),
      members,
      placeExternal,
      whoMayWrite: () => opts.whoMayWrite ?? 'members',
      store: () => ({ emailMessages: { record } as never }),
      now: () => 5,
      warn: () => {}
    })
    return { strategy, record, placeExternal }
  }

  function delivery(ext: WireEmailAdapterExt): { msg: RdMsgIm; normalized: NormalizedMessage } {
    const normalized = {
      msgId: `email:${AGENT}:${ext.messageId}`,
      platform: 'email',
      channel: `dm:${ext.from.address}`,
      thread: ext.messageId,
      sender: { id: ext.from.address, isBot: false },
      text: 'Body text\n\n[Attachment not delivered: a.pdf (application/pdf, 10 bytes)]',
      mentionedBots: [],
      isDm: true,
      source: 'user',
      adapterExt: { email: ext }
    } as unknown as NormalizedMessage
    return { msg: { msgId: normalized.msgId, agentId: AGENT_ID, integrationId: 'int-email' } as RdMsgIm, normalized }
  }

  it('refuses a sender who is not a member, and retries when the question could not be asked', async () => {
    const refused = admitWith(answer(() => false))
    const one = delivery(mail())
    expect(await refused.strategy.admit!(one.msg, one.normalized)).toBe('rejected')
    const offline = admitWith(async () => undefined)
    expect(await offline.strategy.admit!(one.msg, one.normalized)).toBe('retry')
    const unbound = admitWith(answer(() => false))
    expect(await unbound.strategy.admit!({ ...one.msg, integrationId: 'other' }, one.normalized)).toBe('retry')
  })

  it('places a member’s group mail, names who the reply will not reach, and indexes it on admission', async () => {
    const { strategy, record, placeExternal } = admitWith(answer((a) => a !== MALLORY))
    const ext = mail({ cc: [{ address: BOB }, { address: MALLORY }], date: 'Thu, 19 Nov 2026 10:00:00 +0000' })
    const { msg, normalized } = delivery(ext)
    expect(await strategy.admit!(msg, normalized)).toBe('admit')
    expect(normalized.channel).toBe('group:new@corp.example.test')
    expect(normalized.isDm).toBe(false)
    expect(normalized.isGroupDm).toBe(true)
    expect(normalized.mentionedBots).toEqual([AGENT])
    expect(normalized.text).toBe(
      [
        `From: ${ALICE}\nTo: ${AGENT}\nCc: ${BOB}, ${MALLORY}\nSubject: Plan\nDate: Thu, 19 Nov 2026 10:00:00 +0000`,
        'Body text\n\n[Attachment not delivered: a.pdf (application/pdf, 10 bytes)]',
        `[Not members of this organization, so your reply will not be sent to them: ${MALLORY}. Say so in your reply if it matters.]`
      ].join('\n\n')
    )
    await strategy.onAdmitted!(msg, normalized, false, false)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        address: AGENT,
        messageId: 'new@corp.example.test',
        thread: 'new@corp.example.test',
        conversation: 'group:new@corp.example.test',
        direction: 'received',
        ts: 'new@corp.example.test'
      })
    )
    const stored = JSON.parse((record.mock.calls[0] as unknown as [{ mail: string }])[0].mail)
    expect(stored.participants).toEqual([ALICE, BOB, MALLORY])
    // Nobody answered that Mallory is outside, so the place is not reported external.
    expect(placeExternal).not.toHaveBeenCalled()
  })

  describe('under Anyone (§4.1, §5.2)', () => {
    it('admits an authenticated sender no member holds into their own direct conversation, an external place', async () => {
      const { strategy, record, placeExternal } = admitWith(
        answer(() => false, 'admitted'),
        { whoMayWrite: 'anyone' }
      )
      const { msg, normalized } = delivery(mail({ from: { address: STRANGER } }))
      expect(await strategy.admit!(msg, normalized)).toBe('admit')
      expect(normalized.channel).toBe(`dm:${STRANGER}`)
      expect(normalized.isDm).toBe(true)
      expect(placeExternal).toHaveBeenCalledWith(['int-email'], `dm:${STRANGER}`, 'externalMember')
      expect((normalized.adapterExt as { email: WireEmailAdapterExt }).email.outsider).toBe(true)
      await strategy.onAdmitted!(msg, normalized, false, false)
      const stored = JSON.parse((record.mock.calls[0] as unknown as [{ mail: string }])[0].mail)
      expect(stored.outsider).toBe(true)
    })

    it('still recognizes a member as one, and drops an outsider mark the relay set', async () => {
      const { strategy, placeExternal } = admitWith(
        answer((a) => a === ALICE, 'admitted'),
        { whoMayWrite: 'anyone' }
      )
      const { msg, normalized } = delivery(mail({ outsider: true }))
      expect(await strategy.admit!(msg, normalized)).toBe('admit')
      expect((normalized.adapterExt as { email: WireEmailAdapterExt }).email.outsider).toBeUndefined()
      expect(placeExternal).not.toHaveBeenCalled()
    })

    it('refuses an outsider while the spec still says Members, or while their sessions have nowhere to go', async () => {
      const stranger = delivery(mail({ from: { address: STRANGER } }))
      const specClosed = admitWith(
        answer(() => false, 'admitted'),
        { whoMayWrite: 'members' }
      )
      expect(await specClosed.strategy.admit!(stranger.msg, stranger.normalized)).toBe('rejected')
      const nowhere = admitWith(
        answer(() => false, 'refused'),
        { whoMayWrite: 'anyone' }
      )
      expect(await nowhere.strategy.admit!(stranger.msg, stranger.normalized)).toBe('rejected')
    })

    it('retries an unanswered question rather than reading the sender as outside', async () => {
      const offline = admitWith(async () => undefined, { whoMayWrite: 'anyone' })
      const { msg, normalized } = delivery(mail({ from: { address: STRANGER } }))
      expect(await offline.strategy.admit!(msg, normalized)).toBe('retry')
      expect(offline.placeExternal).not.toHaveBeenCalled()
    })

    it('makes a member’s thread with an outsider on it external, and tells the agent who the reply will not reach', async () => {
      const { strategy, placeExternal } = admitWith(
        answer((a) => a === ALICE || a === BOB, 'admitted'),
        {
          whoMayWrite: 'anyone',
          wrote: ['someone@other.example.test']
        }
      )
      const { msg, normalized } = delivery(mail({ cc: [{ address: BOB }, { address: STRANGER }] }))
      expect(await strategy.admit!(msg, normalized)).toBe('admit')
      expect(placeExternal).toHaveBeenCalledWith(['int-email'], 'group:new@corp.example.test', 'externalMember')
      expect(normalized.text).toContain(
        `[Your reply will not be sent to: ${STRANGER}. It goes to members of this organization and to people outside it who have written on this thread themselves. Say so in your reply if it matters.]`
      )
    })

    it('leaves nobody off once the outsider on the thread has written on it', async () => {
      const { strategy } = admitWith(
        answer((a) => a === ALICE, 'admitted'),
        { whoMayWrite: 'anyone', wrote: [STRANGER] }
      )
      const { msg, normalized } = delivery(mail({ cc: [{ address: STRANGER }] }))
      expect(await strategy.admit!(msg, normalized)).toBe('admit')
      expect(normalized.text).not.toContain('will not be sent')
    })
  })

  it('notes recipients that could not be read', () => {
    expect(emailPrompt('Hi', mail({ unreadableRecipients: 2 }), [])).toContain(
      '[2 recipients of this mail could not be read as an address and will not receive your reply.]'
    )
  })
})
