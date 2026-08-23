import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { routeRules } from '../src/router/routing-table.js'
import { sessionKey } from '../src/store/local-store.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import type { TelegramConnection } from '../src/telegram/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

type TelegramPost = TelegramConnection['postMessage']
type TelegramChrome = TelegramConnection['postChrome']
type TelegramCard = TelegramConnection['postCard']

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-tg-thread-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  // No integrations at boot → start() opens no real Telegram long-poll; we attach a
  // routable rule + a fake connection by hand afterwards (mirrors daemon-commands.test).
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** Attach a Telegram integration (mention + dm rules) + a fake connection so bot-a is
 *  routable and its replies land on `conn`. Bot @username is 'mybot'. */
function makeTelegramRoutable(daemon: Daemon) {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'i-tg',
      platform: 'telegram',
      core: { bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
      config: { botToken: '123:abc', botUsername: 'mybot' }
    }
  ]
  const conn = {
    postMessage: vi.fn<TelegramPost>(async () => 'out-1'),
    postChrome: vi.fn<TelegramChrome>(async () => 'out-1'),
    postCard: vi.fn<TelegramCard>(async () => 'card-1'),
    editCard: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {})
  }
  ;(daemon as any).tgConnByIntegration.set('i-tg', conn)
  ;(daemon as any).botUserIds['i-tg'] = 'mybot'
  return conn
}

/** Attach a fail-closed Telegram integration with no enabled conversations. */
function makeTelegramGated(daemon: Daemon) {
  const a = (daemon as any).agents.get('bot-a')
  a.integrations = [
    {
      id: 'i-tg',
      platform: 'telegram',
      core: { bindRules: [], gated: true },
      config: { botToken: '123:abc' }
    }
  ]
  const conn = {
    postChrome: vi.fn(async () => 'notice-1')
  }
  ;(daemon as any).tgConnByIntegration.set('i-tg', conn)
  ;(daemon as any).botUserIds['i-tg'] = 'mybot'
  return conn
}

/** A normalized Telegram message as it arrives from the connection (thread unset — the
 *  daemon derives it). `id` is the Telegram message id; chat is the group -100 unless a
 *  DM is requested. */
function tg(id: number, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const channel = over.channel ?? '-100'
  return {
    msgId: `telegram:${channel}:${id}`,
    traceId: String(id),
    source: 'user',
    platform: 'telegram',
    channel,
    sender: { id: 'U1', isBot: false },
    text: 'hi',
    mentionedBots: [],
    isDm: false,
    ...over
  }
}

/** routeRules stays sync, so the owner is prefetched for the one candidate thread key. */
const owner = async (daemon: Daemon, channel: string, thread: string) => {
  const found = await (daemon as any).sessions.threadOwner(channel, thread)
  return () => found
}

describe('Telegram conversation discovery', () => {
  it('reports a public DM as a configurable direct row', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    makeTelegramRoutable(daemon)
    vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp')
    const emitIntegrationChannels = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels, stop: vi.fn().mockResolvedValue(undefined) }

    await (daemon as any).onInboundOutcome(tg(91, { channel: '424242', isDm: true }), ['i-tg'])

    // `dmUserId` rides a 1:1 DM row (§14.8) — who the conversation is with, which is
    // what lets the CP match it against a private agent's own audience.
    expect(emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: 'i-tg',
      channels: [{ id: '424242', dmUserId: 'U1', kind: 'im' }],
      authoritative: false
    })
    await daemon.stop()
  })

  it('reports an explicitly mentioned Off group before routing drops the message', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const conn = makeTelegramGated(daemon)
    const emitIntegrationChannels = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels, stop: vi.fn().mockResolvedValue(undefined) }

    await (daemon as any).onInboundOutcome(tg(90, { mentionedBots: ['mybot'] }), ['i-tg'])

    const channels = [{ id: '-100', kind: 'channel' }]
    expect(emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: 'i-tg',
      channels,
      authoritative: false
    })
    expect((daemon as any).channelSnapshots.get('i-tg')).toEqual({ channels, authoritative: false })
    expect(conn.postChrome).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('reports a newly joined group without routing its membership service message', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    makeTelegramGated(daemon)
    const emitIntegrationChannels = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels, stop: vi.fn().mockResolvedValue(undefined) }

    await (daemon as any).observedChannelsSync.observeTelegramChat(
      { id: '-200', name: 'new private group', isPrivate: true },
      ['i-tg']
    )

    const channels = [{ id: '-200', name: 'new private group', isPrivate: true, kind: 'channel' }]
    expect(emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: 'i-tg',
      channels,
      authoritative: false
    })
    expect((daemon as any).channelSnapshots.get('i-tg')).toEqual({ channels, authoritative: false })
    await daemon.stop()
  })
})

describe('Telegram ingress attribution', () => {
  it('routes and deduplicates DMs within the bot connection that received them', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const wrong = (daemon as any).agents.get('bot-a')
    wrong.integrations = [
      {
        id: 'wrong-tg',
        platform: 'telegram',
        core: { bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: 'wrong-token' }
      }
    ]
    ;(daemon as any).agents.set('target', {
      ...wrong,
      id: 'target',
      name: 'target',
      integrations: [
        {
          id: 'target-tg',
          platform: 'telegram',
          core: { bindRules: [{ channel: '424242', match: { kind: 'dm' } }], gated: true },
          config: { botToken: 'target-token' }
        }
      ]
    })
    const dispatch = vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp')

    // Separate bot chats can produce the same normalized chat/message coordinates.
    // Each physical connection must route only through its own integration and must
    // not suppress the other bot's event as a duplicate.
    await (daemon as any).onInboundOutcome(tg(1, { channel: '424242', isDm: true }), ['wrong-tg'])
    await (daemon as any).onInboundOutcome(tg(1, { channel: '424242', isDm: true }), ['target-tg'])

    expect(dispatch.mock.calls.map(([agentId, , integrationId]) => [agentId, integrationId])).toEqual([
      ['bot-a', 'wrong-tg'],
      ['target', 'target-tg']
    ])
    await daemon.stop()
  })

  it('keeps a loop-guard trip on one bot from blocking the same DM coordinates on another bot', async () => {
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-b'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async () => 'end_turn'),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: () => host as any
    })
    await daemon.start()
    const agent = (daemon as any).agents.get('bot-a')
    agent.integrations = [
      {
        id: 'i-a',
        platform: 'telegram',
        core: { bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: '111:a' }
      },
      {
        id: 'i-b',
        platform: 'telegram',
        core: { bindRules: [{ match: { kind: 'dm' } }] },
        config: { botToken: '222:b' }
      }
    ]
    const scopeA = (daemon as any).transportScopeForIntegrationIds(['i-a'])
    const scopeB = (daemon as any).transportScopeForIntegrationIds(['i-b'])
    await (daemon as any).store.tripLoopGuard(`telegram:42:dm:${scopeA}`, 1, 'test_loop')

    await expect(
      (daemon as any).dispatch(
        'bot-a',
        tg(1, { channel: '42', thread: 'dm', transportScope: scopeB, isDm: true, headless: true }),
        'i-b'
      )
    ).resolves.toBe('acp-b')
    await expect(
      (daemon as any).dispatch(
        'bot-a',
        tg(1, { channel: '42', thread: 'dm', transportScope: scopeA, isDm: true, headless: true }),
        'i-a'
      )
    ).resolves.toBeNull()
    expect(host.prompt).toHaveBeenCalledOnce()
    await daemon.stop()
  })
})

describe('canonicalizeTelegramThread', () => {
  it('roots a fresh group @mention at its own message (tg:<id>)', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const m = tg(100, { mentionedBots: ['mybot'] })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:100')
  })

  it('uses the forum-topic id as the thread', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const m = tg(101, { topicId: '555', mentionedBots: ['mybot'] })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('555')
  })

  it('§6.5: keys off the GENERIC coordinates alone (post-window emission)', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const topic = tg(103, { topicId: '555', mentionedBots: ['mybot'] })
    await (daemon as any).canonicalizeTelegramThread(topic)
    expect(topic.thread).toBe('555')
    const reply = tg(104, { threadRoot: '6' })
    await (daemon as any).canonicalizeTelegramThread(reply)
    expect(reply.thread).toBe('tg:6')
    // The generic field wins when both are present (dual-shape window).
    const both = tg(105, { topicId: '7' })
    await (daemon as any).canonicalizeTelegramThread(both)
    expect(both.thread).toBe('7')
  })

  it('collapses a DM to one continuous session (dm)', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const m = tg(102, { channel: '42', isDm: true })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('dm')
  })

  it('keys a plain-supergroup reply thread by its native root — matching the opening @mention', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    // The opening @mention (message 6) is top-level: no topic, no root, no reply.
    const mention = tg(6, { mentionedBots: ['mybot'] })
    await (daemon as any).canonicalizeTelegramThread(mention)
    expect(mention.thread).toBe('tg:6')
    // A later reply in that thread carries Telegram's native message_thread_id = 6
    // (the root) — even though it directly replies to the bot's message 7. It must key
    // to the SAME session as the mention (regression: was mis-keyed to the bare id).
    const reply = tg(8, { threadRoot: '6', replyTo: '7' })
    await (daemon as any).canonicalizeTelegramThread(reply)
    expect(reply.thread).toBe('tg:6')
  })

  it('does not treat a plain-supergroup reply-thread root as a forum topic', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    // Only a real forum topic yields the bare numeric thread (postable as
    // message_thread_id); a reply-thread root is prefixed so it never is.
    const forum = tg(9, { topicId: '6' })
    await (daemon as any).canonicalizeTelegramThread(forum)
    expect(forum.thread).toBe('6')
    const replyThread = tg(10, { threadRoot: '6' })
    await (daemon as any).canonicalizeTelegramThread(replyThread)
    expect(replyThread.thread).toBe('tg:6')
  })

  it('continues the session a replied-to message belongs to', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    // A prior bot reply (message 500) recorded under the session thread tg:100.
    await (daemon as any).store.appendTranscript({
      channel: '-100',
      thread: 'tg:100',
      ts: '500',
      sender: 'bot-a',
      kind: 'text',
      text: 'answer'
    })
    const m = tg(600, { replyTo: '500' })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:100')
  })

  it('roots a basic-group reply on the replied-to message when the transcript has no record', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    // No message_thread_id (basic group) and message 999 was never recorded (cold /
    // restarted): fall back to rooting the thread on the replied-to message.
    const m = tg(700, { replyTo: '999' })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:999')
  })

  it('leaves non-telegram messages untouched', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const m = { ...tg(1), platform: 'slack' as const, thread: undefined }
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBeUndefined()
  })
})

describe('reply-based session continuity (routing)', () => {
  it('routes a reply-to-bot to the session owner via thread affinity — no @mention needed', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    makeTelegramRoutable(daemon)
    // Simulate an established session for thread tg:100 + its bot reply (message 500).
    const now = Date.now()
    await (daemon as any).store.upsertSession({
      key: sessionKey('telegram', '-100', 'tg:100', 'bot-a'),
      agentId: 'bot-a',
      platform: 'telegram',
      channel: '-100',
      thread: 'tg:100',
      acpSessionId: 'acp-x',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: now
    })
    await (daemon as any).store.appendTranscript({
      channel: '-100',
      thread: 'tg:100',
      ts: '500',
      sender: 'bot-a',
      kind: 'text',
      text: 'answer'
    })

    // A human reply to the bot's message (no @mention).
    const m = tg(600, { replyTo: '500' })
    await (daemon as any).canonicalizeTelegramThread(m)
    const routed = routeRules(m, (daemon as any).mergedRules(), await owner(daemon, m.channel, m.thread!))
    expect(routed).toMatchObject({ agentId: 'bot-a', via: 'thread' })
  })

  it('resolves identical thread coordinates independently on each receiving bot', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    makeScopedTelegramPair(daemon)
    await seedSession(daemon, '-100', 'tg:77', { agentId: 'bot-a', integrationId: 'i-a' })
    await seedSession(daemon, '-100', 'tg:77', { agentId: 'bot-b', integrationId: 'i-b' })
    const dispatch = vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp')

    await (daemon as any).onInboundOutcome(tg(78, { threadRoot: '77', text: 'follow up A' }), ['i-a'])
    await (daemon as any).onInboundOutcome(tg(78, { threadRoot: '77', text: 'follow up B' }), ['i-b'])

    expect(dispatch.mock.calls.map(([agentId, , integrationId]) => [agentId, integrationId])).toEqual([
      ['bot-a', 'i-a'],
      ['bot-b', 'i-b']
    ])
    await daemon.stop()
  })

  it('a fresh @mention with no reply starts a new, distinct session thread', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    makeTelegramRoutable(daemon)
    const m = tg(800, { mentionedBots: ['mybot'] })
    await (daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:800')
    const routed = routeRules(m, (daemon as any).mergedRules(), await owner(daemon, m.channel, m.thread!))
    expect(routed).toMatchObject({ agentId: 'bot-a', via: 'mention' })
  })
})

describe('reply targeting', () => {
  it('a command reply threads under the triggering Telegram message', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    // A DM `/status` with no live session → the "no session" note, replied to message 900.
    await (daemon as any).onInboundOutcome(tg(900, { channel: '42', isDm: true, text: '/status' }), ['i-tg'])
    expect(conn.postMessage).toHaveBeenCalledWith('42', expect.stringContaining('No active session'), 'dm', {
      replyTo: 900
    })
  })

  it('an agent-call turn falls back to the session thread root as its reply anchor', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const replyTarget = (m: NormalizedMessage) => (daemon as any).telegramReplyTarget(m)
    // A synthesized agent-call delivery (replyToSession / peer wake) — its msgId carries
    // no platform message id, so pre-fix the turn's answer posted to the chat root,
    // visually outside the reply chain the session lives in.
    const agentCall = (thread?: string): NormalizedMessage => ({
      msgId: 'agentcall:-100:2f1b2c1e-aaaa-bbbb-cccc-121212121212',
      traceId: 'd1',
      source: 'agent',
      platform: 'telegram',
      channel: '-100',
      ...(thread !== undefined ? { thread } : {}),
      sender: { id: 'bot-b', isBot: true },
      text: 'answer',
      mentionedBots: [],
      isDm: false
    })
    // Reply-based session → anchor to the thread root (the customer's message).
    expect(replyTarget(agentCall('tg:170'))).toBe(170)
    // DM sessions are a single stream — no anchor, plain post as before.
    expect(replyTarget(agentCall('dm'))).toBeUndefined()
    // A numeric thread is a forum topic id (drives message_thread_id at post time),
    // never a reply anchor.
    expect(replyTarget(agentCall('172'))).toBeUndefined()
    // A real platform message still replies to ITSELF, not the thread root.
    expect(replyTarget(tg(456, { thread: 'tg:100' }))).toBe(456)
    await daemon.stop()
  })
})

/** Seed an addressable session in one physical Telegram bot scope. */
async function seedSession(
  daemon: Daemon,
  channel: string,
  thread: string,
  opts: {
    agentId?: string
    integrationId?: string
    acpSessionId?: string
    updatedAt?: number
  } = {}
) {
  const agentId = opts.agentId ?? 'bot-a'
  const integrationId = opts.integrationId ?? 'i-tg'
  const transportScope = (daemon as any).transportScopeForIntegrationIds([integrationId])
  const key = sessionKey('telegram', channel, thread, agentId, transportScope)
  await (daemon as any).store.upsertSession({
    key,
    agentId,
    platform: 'telegram',
    channel,
    thread,
    transportScope,
    acpSessionId: opts.acpSessionId ?? `acp-${agentId}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: opts.updatedAt ?? Date.now()
  })
  return key
}

function makeScopedTelegramPair(daemon: Daemon) {
  const agentA = (daemon as any).agents.get('bot-a')
  agentA.integrations = [
    {
      id: 'i-a',
      platform: 'telegram',
      core: { bindRules: [{ match: { kind: 'mention' } }] },
      config: { botToken: '111:a', botUsername: 'bota' }
    }
  ]
  const agentB = {
    ...agentA,
    id: 'bot-b',
    name: 'bot-b',
    integrations: [
      {
        id: 'i-b',
        platform: 'telegram',
        core: { bindRules: [{ match: { kind: 'mention' } }] },
        config: { botToken: '222:b', botUsername: 'botb' }
      }
    ]
  }
  ;(daemon as any).agents.set('bot-b', agentB)
  const connection = () => ({
    postMessage: vi.fn(async () => 'out-1'),
    postChrome: vi.fn(async () => 'chrome-1'),
    postCard: vi.fn(async () => 'card-1'),
    editCard: vi.fn(async () => {}),
    answerCallback: vi.fn(async () => {})
  })
  const connA = connection()
  const connB = connection()
  ;(daemon as any).tgConnByIntegration.set('i-a', connA)
  ;(daemon as any).tgConnByIntegration.set('i-b', connB)
  ;(daemon as any).botUserIds['i-a'] = 'bota'
  ;(daemon as any).botUserIds['i-b'] = 'botb'
  return { agentA, agentB, connA, connB }
}

describe('group command routing (no mention entity)', () => {
  it('routes a bare group /status@bot to the channel latest session — replies under the command', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    await seedSession(daemon, '-100', 'tg:100')
    // A group `/status@mybot`: no mention entity, no reply, not a DM — routeRules can't
    // place it, so it must fall back to the channel's latest session (not be dropped).
    await (daemon as any).onInboundOutcome(tg(200, { text: '/status@mybot' }), ['i-tg'])
    expect(conn.postChrome).toHaveBeenCalled()
    const [ch, , opts] = conn.postChrome.mock.calls.at(-1)!
    expect(ch).toBe('-100')
    expect(opts).toMatchObject({ replyTo: 200 }) // reply threads under the command message
  })

  it('finds the latest eligible session on the bot that received the command', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const { connA, connB } = makeScopedTelegramPair(daemon)
    const now = Date.now()
    await seedSession(daemon, '-100', 'tg:a', {
      agentId: 'bot-a',
      integrationId: 'i-a',
      updatedAt: now
    })
    await seedSession(daemon, '-100', 'tg:b', {
      agentId: 'bot-b',
      integrationId: 'i-b',
      updatedAt: now - 1_000
    })

    await (daemon as any).onInboundOutcome(tg(201, { text: '/status@botb' }), ['i-b'])

    expect(connB.postChrome).toHaveBeenCalled()
    expect(connA.postChrome).not.toHaveBeenCalled()
    await daemon.stop()
  })
})

/** Inject a host advertising model/effort/permission selectors for bot-a. */
function injectHost(daemon: Daemon) {
  const host = {
    hasSession: () => true,
    modelOptions: () => ({ current: 'opus', models: ['opus', 'sonnet'] }),
    effortOptions: () => ({ current: 'medium', efforts: ['low', 'medium', 'high'] }),
    permissionModeOptions: () => ({ current: 'default', modes: ['default', 'plan'] }),
    fastModeOption: () => null,
    setSessionModel: vi.fn(async () => true),
    setSessionEffort: vi.fn(async () => true),
    setSessionPermissionMode: vi.fn(async () => true)
  }
  ;(daemon as any).hosts.set('bot-a', host)
  return host
}

describe('session-control cards (/models tappable buttons)', () => {
  it('renders a tappable card for a bare /models with the current model flagged', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    await seedSession(daemon, '-100', 'tg:100')

    await (daemon as any).onInboundOutcome(tg(200, { text: '/models@mybot' }), ['i-tg'])
    expect(conn.postCard).toHaveBeenCalled()
    const [ch, , buttons] = conn.postCard.mock.calls.at(-1)!
    expect(ch).toBe('-100')
    expect(buttons).toEqual([[{ text: '✅ opus', callbackData: 'm:0' }], [{ text: 'sonnet', callbackData: 'm:1' }]])
  })

  it('applies the tapped button, acks it, and re-renders the card', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    const key = await seedSession(daemon, '-100', 'tg:100')

    await (daemon as any).commands.handleTelegramCallback(
      { id: 'cb1', data: 'm:1', channel: '-100', messageId: 55, userId: 'U1' },
      conn
    )
    expect(await (daemon as any).store.getModelOverride(key)).toBe('sonnet')
    expect(conn.answerCallback).toHaveBeenCalledWith('cb1', expect.stringContaining('sonnet'))
    expect(conn.editCard).toHaveBeenCalled()
  })

  it('attributes an applied tap to the tapping user, and records nothing when refused', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    await seedSession(daemon, '-100', 'tg:100')
    const lines: string[] = []
    ;(daemon as any).log = { info: (m: string) => lines.push(m), warn: () => {}, error: () => {}, debug: () => {} }

    await (daemon as any).commands.handleTelegramCallback(
      { id: 'cb-a', data: 'm:1', channel: '-100', messageId: 55, userId: 'U-DANA' },
      conn
    )
    const applied = lines.filter((l) => l.includes('select:model'))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('U-DANA')

    // Withdraw chat authority: the next tap changes nothing, so it records nothing.
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = false
    lines.length = 0
    await (daemon as any).commands.handleTelegramCallback(
      { id: 'cb-b', data: 'm:0', channel: '-100', messageId: 55, userId: 'U-DANA' },
      conn
    )
    expect(lines.filter((l) => l.includes('select:model'))).toEqual([])
  })

  it('applies a callback only to a session owned by the bot that delivered the tap', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const { agentA, agentB, connB } = makeScopedTelegramPair(daemon)
    agentA.allowRuntimeChangesInChat = true
    agentB.allowRuntimeChangesInChat = true
    const host = {
      hasSession: () => true,
      modelOptions: () => ({ current: 'opus', models: ['opus', 'sonnet'] }),
      effortOptions: () => ({ current: 'medium', efforts: ['low', 'medium', 'high'] }),
      permissionModeOptions: () => ({ current: 'default', modes: ['default', 'plan'] }),
      fastModeOption: () => null,
      setSessionModel: vi.fn(async () => true),
      setSessionEffort: vi.fn(async () => true),
      setSessionPermissionMode: vi.fn(async () => true),
      stop: vi.fn(async () => {})
    }
    ;(daemon as any).hosts.set('bot-a', host)
    ;(daemon as any).hosts.set('bot-b', host)
    const now = Date.now()
    const keyA = await seedSession(daemon, '-100', 'tg:a', {
      agentId: 'bot-a',
      integrationId: 'i-a',
      updatedAt: now
    })
    const keyB = await seedSession(daemon, '-100', 'tg:b', {
      agentId: 'bot-b',
      integrationId: 'i-b',
      updatedAt: now - 1_000
    })

    await (daemon as any).commands.handleTelegramCallback(
      { id: 'cb-scoped', data: 'm:1', channel: '-100', messageId: 55, userId: 'U1' },
      connB
    )

    expect(await (daemon as any).store.getModelOverride(keyB)).toBe('sonnet')
    expect(await (daemon as any).store.getModelOverride(keyA)).toBeUndefined()
    expect(connB.answerCallback).toHaveBeenCalledWith('cb-scoped', expect.stringContaining('sonnet'))
    await daemon.stop()
  })
})

describe('continue-the-topic hint delivery', () => {
  /** A minimal Pending for a group turn, plus a fake connection recording sends/edits. */
  function pending(daemon: Daemon) {
    const conn = {
      postMessage: vi.fn<TelegramPost>(async () => 'out-9'),
      postChrome: vi.fn<TelegramChrome>(async () => 'chrome-1'),
      updateMessage: vi.fn(async () => {}),
      sendChatAction: vi.fn(async () => {})
    }
    const p = {
      plan: {
        agentId: 'bot-a',
        channel: '-100',
        transcriptChannel: '-100',
        statusThread: 'tg:100',
        thread: 'tg:100',
        approvalSurfaceSuppressed: false
      },
      chrome: {},
      // §7.3: Telegram's per-turn state lives in the opaque slot, seeded by its
      // output surface at dispatch (here, by hand).
      turnState: { replyTo: 100 } as { replyTo?: number; lastBody?: { id: string; text: string } },
      conn
    }
    return { conn, p, apply: (a: unknown) => (daemon as any).applyTelegramAction(p, a) }
  }

  it('sends the hint with the reply but keeps it out of the transcript', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const { conn, p, apply } = pending(daemon)

    await apply({ kind: 'post', text: 'answer', hint: '↩️ hint' })

    expect(conn.postMessage.mock.calls[0]![1]).toBe('answer\n\n↩️ hint')
    // The recorded row keeps the agent's words AND the real message id — the reply chain
    // resolves through it (LocalStore.telegramThreadForMessage).
    const rows = await (daemon as any).store.threadTranscript('-100', 'tg:100')
    expect(rows.at(-1)).toMatchObject({ text: 'answer', ts: 'out-9' })
    expect(await (daemon as any).store.telegramThreadForMessage('-100', 'out-9')).toBe('tg:100')
    expect(p.turnState).toMatchObject({ lastBody: { id: 'out-9', text: 'answer\n\n↩️ hint' } })
    await daemon.stop()
  })

  it('edits the hint onto the body already sent when the turn ends empty', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const { conn, apply } = pending(daemon)

    await apply({ kind: 'post', text: 'earlier answer' })
    await apply({ kind: 'continue-hint', hint: '↩️ hint' })

    expect(conn.updateMessage).toHaveBeenCalledWith('-100', 'out-9', 'earlier answer\n\n↩️ hint')
    // Idempotent: a second hint action never doubles the line.
    await apply({ kind: 'continue-hint', hint: '↩️ hint' })
    expect(conn.updateMessage).toHaveBeenCalledOnce()
    await daemon.stop()
  })

  it('skips the edit when no body was sent, or when the suffix would breach the cap', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    const { conn, apply } = pending(daemon)

    // No body yet → nothing to annotate.
    await apply({ kind: 'continue-hint', hint: '↩️ hint' })
    expect(conn.updateMessage).not.toHaveBeenCalled()

    // A maximal message (only reachable from a build that predates the budget reservation)
    // is left alone rather than sent over the cap.
    await apply({ kind: 'post', text: 'x'.repeat(4096) })
    await apply({ kind: 'continue-hint', hint: '↩️ hint' })
    expect(conn.updateMessage).not.toHaveBeenCalled()
    await daemon.stop()
  })
})
