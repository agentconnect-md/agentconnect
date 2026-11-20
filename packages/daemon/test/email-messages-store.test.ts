// The mail index and the history reads served from it (email-integration.md §5.6), on whichever store backend the project runs.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { WireEmailAdapterExt } from '@agentconnect.md/protocol'
import { EmailConnection, type EmailStoredMail } from '../src/platforms/email/connection.js'
import { EMAIL_MESSAGE_SCHEMA } from '../src/store/email-messages.js'
import { transcriptChannelKey, type LocalStore } from '../src/store/local-store.js'
import { canonicalColumns } from '../src/store/postgres-dialect.js'
import { openTestStore } from './store-support.js'

const AGENT = '00000000-0000-4000-8000-0000000000a1'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const SCOPE = 'email:scope'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

// Each test its own address, so rows a shared pool store keeps from another test never meet.
function address(): string {
  return `helper-${randomUUID().slice(0, 8)}@mail.example.test`
}

function mail(over: Partial<WireEmailAdapterExt> = {}): WireEmailAdapterExt {
  return {
    from: { address: 'alice@corp.example.test', name: 'Alice' },
    to: [],
    cc: [],
    subject: 'Quarterly numbers',
    messageId: 'm1@corp.example.test',
    references: [],
    attachments: [],
    ...over
  }
}

function connection(opened: LocalStore, agentAddress: string): EmailConnection {
  return new EmailConnection({
    group: {
      key: agentAddress,
      config: { address: agentAddress, egress: 'relay', botId: BOT },
      integrations: [{ agentId: AGENT, integrationId: 'int-email' }]
    },
    store: () => opened,
    transcriptChannel: (channel) => transcriptChannelKey(channel, SCOPE)
  })
}

// One message as the module records it: its transcript row, admitted by the agent, and its index row.
async function received(
  opened: LocalStore,
  agentAddress: string,
  at: { conversation: string; thread: string; ts: string; text: string; ext: WireEmailAdapterExt }
): Promise<void> {
  await opened.appendTranscript({
    channel: transcriptChannelKey(at.conversation, SCOPE),
    thread: at.thread,
    admission: { agentId: AGENT, sessionKey: `email:${at.conversation}:${at.thread}` },
    ts: at.ts,
    sender: at.ext.from.address,
    kind: 'text',
    text: at.text
  })
  const stored: EmailStoredMail = { ...at.ext, participants: [at.ext.from.address] }
  await opened.emailMessages.record({
    address: agentAddress,
    messageId: at.ext.messageId,
    thread: at.thread,
    conversation: at.conversation,
    direction: 'received',
    mail: JSON.stringify(stored),
    ts: at.ts,
    createdAt: 1
  })
}

async function sent(
  opened: LocalStore,
  agentAddress: string,
  at: { conversation: string; thread: string; ts: string; text: string; outcome: 'sent' | 'unsent'; reason?: string }
): Promise<void> {
  await opened.appendTranscript({
    channel: transcriptChannelKey(at.conversation, SCOPE),
    thread: at.thread,
    admission: { agentId: AGENT, sessionKey: `email:${at.conversation}:${at.thread}` },
    ts: at.ts,
    sender: AGENT,
    kind: 'text',
    text: at.text
  })
  await opened.emailMessages.record({
    address: agentAddress,
    thread: at.thread,
    conversation: at.conversation,
    direction: 'sent',
    mail: JSON.stringify({
      from: { address: agentAddress, name: 'Helper' },
      to: [{ address: 'alice@corp.example.test' }],
      cc: [],
      subject: 'Re: Quarterly numbers'
    }),
    ts: at.ts,
    outcome: at.outcome,
    ...(at.reason ? { reason: at.reason } : {}),
    createdAt: 2
  })
}

describe('the mail index', () => {
  it('keeps a message ID once per address, and a sent mail with no provider id any number of times', async () => {
    store = await openTestStore()
    const agentAddress = address()
    const row = {
      address: agentAddress,
      messageId: 'm1@corp.example.test',
      thread: 'm1@corp.example.test',
      conversation: 'dm:alice@corp.example.test',
      direction: 'received' as const,
      createdAt: 1
    }
    expect(await store.emailMessages.record(row)).toBe(true)
    expect(await store.emailMessages.record({ ...row, thread: 'other' })).toBe(false)
    expect((await store.emailMessages.get(agentAddress, 'm1@corp.example.test'))?.thread).toBe('m1@corp.example.test')
    expect(await store.emailMessages.get(address(), 'm1@corp.example.test')).toBeUndefined()
    const unsent = { ...row, messageId: undefined, direction: 'sent' as const, outcome: 'unsent' as const }
    expect(await store.emailMessages.record(unsent)).toBe(true)
    expect(await store.emailMessages.record(unsent)).toBe(true)
    const thread = await store.emailMessages.threadMessages(agentAddress, row.conversation, row.thread, 10)
    expect(thread.rows.map((r) => [r.direction, r.outcome ?? null])).toEqual([
      ['received', null],
      ['sent', 'unsent'],
      ['sent', 'unsent']
    ])
  })

  it('reads a conversation’s first and latest received mail, and its threads newest first', async () => {
    store = await openTestStore()
    const agentAddress = address()
    const base = { address: agentAddress, conversation: 'group:t1', direction: 'received' as const, createdAt: 1 }
    await store.emailMessages.record({ ...base, messageId: 'a', thread: 't1' })
    await store.emailMessages.record({ ...base, messageId: 'b', thread: 't1' })
    await store.emailMessages.record({ ...base, messageId: 'c', thread: 't2' })
    expect((await store.emailMessages.firstReceived(agentAddress, 'group:t1'))?.messageId).toBe('a')
    expect((await store.emailMessages.latestReceived(agentAddress, 'group:t1'))?.messageId).toBe('c')
    expect((await store.emailMessages.latestReceived(agentAddress, 'group:t1', 't1'))?.messageId).toBe('b')
    const threads = await store.emailMessages.threads(agentAddress, 'group:t1', { limit: 10 })
    expect(threads.map((t) => [t.thread, t.count])).toEqual([
      ['t2', 1],
      ['t1', 2]
    ])
    const older = await store.emailMessages.threads(agentAddress, 'group:t1', { before: threads[0]!.first, limit: 10 })
    expect(older.map((t) => t.thread)).toEqual(['t1'])
  })

  it('lists every camelCase column in canonicalColumns', () => {
    const names = new Set([...EMAIL_MESSAGE_SCHEMA.matchAll(/\b[a-z]+[A-Z][A-Za-z]*\b/g)].map((m) => m[0]))
    const canonical = new Set<string>(canonicalColumns)
    expect([...names].filter((name) => !canonical.has(name))).toEqual([])
  })
})

describe('history reads from the daemon’s records', () => {
  it('lists the first mail of each thread of a conversation, newest first, with the count after it', async () => {
    store = await openTestStore()
    const agentAddress = address()
    const conn = connection(store, agentAddress)
    const dm = 'dm:alice@corp.example.test'
    await received(store, agentAddress, {
      conversation: dm,
      thread: 'm1@corp.example.test',
      ts: 'm1',
      text: 'From: Alice <alice@corp.example.test>\nSubject: Quarterly numbers\n\nCan you sum these?',
      ext: mail()
    })
    await sent(store, agentAddress, {
      conversation: dm,
      thread: 'm1@corp.example.test',
      ts: 's1',
      text: 'The total is 42.',
      outcome: 'sent'
    })
    await received(store, agentAddress, {
      conversation: dm,
      thread: 'm2@corp.example.test',
      ts: 'm2',
      text: 'From: Alice <alice@corp.example.test>\nSubject: Travel\n\nBook me a train.',
      ext: mail({ messageId: 'm2@corp.example.test', subject: 'Travel' })
    })
    const page = await conn.getChannelHistory(dm, { limit: 1 })
    expect(page.messages.map((m) => [m.threadTs, m.replyCount, m.sender])).toEqual([
      ['m2@corp.example.test', 0, 'alice@corp.example.test']
    ])
    expect(page.hasMore).toBe(true)
    const next = await conn.getChannelHistory(dm, { cursor: page.nextCursor!, limit: 5 })
    expect(next.messages.map((m) => [m.threadTs, m.replyCount])).toEqual([['m1@corp.example.test', 1]])
    expect(next.messages[0]!.text).toContain('Can you sum these?')
    expect(next.hasMore).toBe(false)
  })

  it('reads one thread in full, sent mail with its header block, and only within the conversation it names', async () => {
    store = await openTestStore()
    const agentAddress = address()
    const conn = connection(store, agentAddress)
    const dm = 'dm:alice@corp.example.test'
    const thread = 'm1@corp.example.test'
    await received(store, agentAddress, { conversation: dm, thread, ts: 'm1', text: 'Can you sum these?', ext: mail() })
    await sent(store, agentAddress, {
      conversation: dm,
      thread,
      ts: 's1',
      text: 'The total is 42.',
      outcome: 'unsent',
      reason: 'the relay refused it (budget_bot)'
    })
    // The same thread key in a group conversation stays out of the direct conversation's read, and the other way round.
    await received(store, agentAddress, {
      conversation: `group:${thread}`,
      thread,
      ts: 'g1',
      text: 'Group only',
      ext: mail({ messageId: 'g1@corp.example.test' })
    })
    const readState = { truncated: true }
    const messages = await conn.getThreadReplies(dm, thread, 10, { readState })
    expect(messages.map((m) => [m.sender, m.isBot])).toEqual([
      ['alice@corp.example.test', false],
      [AGENT, true]
    ])
    expect(messages[1]!.text).toMatch(
      /^From: Helper <helper-.*>\nTo: alice@corp\.example\.test\nSubject: Re: Quarterly/
    )
    expect(messages[1]!.text).toContain('[Not delivered: the relay refused it (budget_bot)]')
    expect(messages[1]!.text).toContain('The total is 42.')
    expect(readState.truncated).toBe(false)
    expect((await conn.getThreadReplies(`group:${thread}`, thread)).map((m) => m.text)).toEqual(['Group only'])
    expect((await conn.getThreadReplies(dm, thread, 1, { readState })).length).toBe(1)
    expect(readState.truncated).toBe(true)
  })

  it('names a conversation’s current members: a direct one’s member, a group’s latest participants', async () => {
    store = await openTestStore()
    const agentAddress = address()
    const conn = connection(store, agentAddress)
    expect(await conn.listMemberIds('dm:alice@corp.example.test')).toEqual(['alice@corp.example.test'])
    const group = 'group:t1'
    const base = { address: agentAddress, conversation: group, thread: 't1', direction: 'received' as const }
    const stored = (from: string, participants: string[], messageId: string): string =>
      JSON.stringify({ ...mail({ from: { address: from }, messageId }), participants })
    await store.emailMessages.record({
      ...base,
      messageId: 'a',
      mail: stored('alice@corp.example.test', ['alice@corp.example.test', 'bob@corp.example.test'], 'a'),
      createdAt: 1
    })
    await store.emailMessages.record({
      ...base,
      messageId: 'b',
      mail: stored(
        'bob@corp.example.test',
        ['bob@corp.example.test', 'alice@corp.example.test', 'carol@corp.example.test'],
        'b'
      ),
      createdAt: 2
    })
    expect(await conn.listMemberIds(group)).toEqual([
      'bob@corp.example.test',
      'alice@corp.example.test',
      'carol@corp.example.test'
    ])
    expect(await conn.conversation(group)).toEqual({
      opener: 'alice@corp.example.test',
      members: ['bob@corp.example.test', 'alice@corp.example.test', 'carol@corp.example.test']
    })
    expect(await conn.listMemberIds('group:unknown')).toEqual([])
  })
})
