import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { routeRules } from '../src/router/routing-table.js'
import { sessionKey } from '../src/store/local-store.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'

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
      telegram: {
        botToken: '123:abc',
        botUsername: 'mybot',
        allowedUserIds: [],
        bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }]
      }
    }
  ]
  const conn = {
    postMessage: vi.fn(async () => 'out-1'),
    postChrome: vi.fn(async () => 'out-1'),
    postCard: vi.fn(async () => 'card-1'),
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
      telegram: {
        botToken: '123:abc',
        allowedUserIds: [],
        bindRules: [],
        gated: true
      }
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

const owner = (daemon: Daemon) => (c: string, t: string) => (daemon as any).sessions.threadOwner(c, t)

describe('gated Telegram conversation discovery', () => {
  it('reports an explicitly mentioned Off group before routing drops the message', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const conn = makeTelegramGated(daemon)
    const emitIntegrationChannels = vi.fn()
    ;(daemon as any).cpClient = { emitIntegrationChannels, stop: vi.fn().mockResolvedValue(undefined) }

    ;(daemon as any).onInbound(tg(90, { mentionedBots: ['mybot'] }), ['i-tg'])

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
})

describe('Telegram ingress attribution', () => {
  it('routes and deduplicates DMs within the bot connection that received them', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const wrong = (daemon as any).agents.get('bot-a')
    wrong.integrations = [
      {
        id: 'wrong-tg',
        platform: 'telegram',
        telegram: {
          botToken: 'wrong-token',
          allowedUserIds: [],
          bindRules: [{ match: { kind: 'dm' } }]
        }
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
          telegram: {
            botToken: 'target-token',
            allowedUserIds: [],
            bindRules: [{ channel: '424242', match: { kind: 'dm' } }],
            gated: true
          }
        }
      ]
    })
    const dispatch = vi.spyOn(daemon as any, 'dispatch').mockResolvedValue('acp')

    // Separate bot chats can produce the same normalized chat/message coordinates.
    // Each physical connection must route only through its own integration and must
    // not suppress the other bot's event as a duplicate.
    ;(daemon as any).onInbound(tg(1, { channel: '424242', isDm: true }), ['wrong-tg'])
    ;(daemon as any).onInbound(tg(1, { channel: '424242', isDm: true }), ['target-tg'])

    expect(dispatch.mock.calls.map(([agentId, , integrationId]) => [agentId, integrationId])).toEqual([
      ['bot-a', 'wrong-tg'],
      ['target', 'target-tg']
    ])
    await daemon.stop()
  })
})

describe('canonicalizeTelegramThread', () => {
  it('roots a fresh group @mention at its own message (tg:<id>)', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const m = tg(100, { mentionedBots: ['mybot'] })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:100')
  })

  it('uses the forum-topic id as the thread', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const m = tg(101, { telegramTopicId: '555', mentionedBots: ['mybot'] })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('555')
  })

  it('collapses a DM to one continuous session (dm)', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const m = tg(102, { channel: '42', isDm: true })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('dm')
  })

  it('keys a plain-supergroup reply thread by its native root — matching the opening @mention', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    // The opening @mention (message 6) is top-level: no topic, no root, no reply.
    const mention = tg(6, { mentionedBots: ['mybot'] })
    ;(daemon as any).canonicalizeTelegramThread(mention)
    expect(mention.thread).toBe('tg:6')
    // A later reply in that thread carries Telegram's native message_thread_id = 6
    // (the root) — even though it directly replies to the bot's message 7. It must key
    // to the SAME session as the mention (regression: was mis-keyed to the bare id).
    const reply = tg(8, { telegramThreadRoot: '6', replyTo: '7' })
    ;(daemon as any).canonicalizeTelegramThread(reply)
    expect(reply.thread).toBe('tg:6')
  })

  it('does not treat a plain-supergroup reply-thread root as a forum topic', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    // Only a real forum topic yields the bare numeric thread (postable as
    // message_thread_id); a reply-thread root is prefixed so it never is.
    const forum = tg(9, { telegramTopicId: '6' })
    ;(daemon as any).canonicalizeTelegramThread(forum)
    expect(forum.thread).toBe('6')
    const replyThread = tg(10, { telegramThreadRoot: '6' })
    ;(daemon as any).canonicalizeTelegramThread(replyThread)
    expect(replyThread.thread).toBe('tg:6')
  })

  it('continues the session a replied-to message belongs to', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    // A prior bot reply (message 500) recorded under the session thread tg:100.
    ;(daemon as any).store.appendTranscript({
      channel: '-100',
      thread: 'tg:100',
      ts: '500',
      sender: 'bot-a',
      kind: 'text',
      text: 'answer'
    })
    const m = tg(600, { replyTo: '500' })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:100')
  })

  it('roots a basic-group reply on the replied-to message when the transcript has no record', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    // No message_thread_id (basic group) and message 999 was never recorded (cold /
    // restarted): fall back to rooting the thread on the replied-to message.
    const m = tg(700, { replyTo: '999' })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:999')
  })

  it('leaves non-telegram messages untouched', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const m = { ...tg(1), platform: 'slack' as const, thread: undefined }
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBeUndefined()
  })
})

describe('reply-based session continuity (routing)', () => {
  it('routes a reply-to-bot to the session owner via thread affinity — no @mention needed', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    makeTelegramRoutable(daemon)
    // Simulate an established session for thread tg:100 + its bot reply (message 500).
    const now = Date.now()
    ;(daemon as any).store.upsertSession({
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
    ;(daemon as any).store.appendTranscript({
      channel: '-100',
      thread: 'tg:100',
      ts: '500',
      sender: 'bot-a',
      kind: 'text',
      text: 'answer'
    })

    // A human reply to the bot's message (no @mention).
    const m = tg(600, { replyTo: '500' })
    ;(daemon as any).canonicalizeTelegramThread(m)
    const routed = routeRules(m, (daemon as any).mergedRules(), owner(daemon))
    expect(routed).toMatchObject({ agentId: 'bot-a', via: 'thread' })
  })

  it('a fresh @mention with no reply starts a new, distinct session thread', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    makeTelegramRoutable(daemon)
    const m = tg(800, { mentionedBots: ['mybot'] })
    ;(daemon as any).canonicalizeTelegramThread(m)
    expect(m.thread).toBe('tg:800')
    const routed = routeRules(m, (daemon as any).mergedRules(), owner(daemon))
    expect(routed).toMatchObject({ agentId: 'bot-a', via: 'mention' })
  })
})

describe('reply targeting', () => {
  it('a command reply threads under the triggering Telegram message', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    // A DM `/status` with no live session → the "no session" note, replied to message 900.
    ;(daemon as any).onInbound(tg(900, { channel: '42', isDm: true, text: '/status' }))
    expect(conn.postMessage).toHaveBeenCalledWith('42', expect.stringContaining('No active session'), 'dm', {
      replyTo: 900
    })
  })
})

/** Seed an addressable session for bot-a in a channel so command routing can resolve it. */
function seedSession(daemon: Daemon, channel: string, thread: string) {
  ;(daemon as any).store.upsertSession({
    key: sessionKey('telegram', channel, thread, 'bot-a'),
    agentId: 'bot-a',
    platform: 'telegram',
    channel,
    thread,
    acpSessionId: 'acp-x',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
}

describe('group command routing (no mention entity)', () => {
  it('routes a bare group /status@bot to the channel latest session — replies under the command', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    seedSession(daemon, '-100', 'tg:100')
    // A group `/status@mybot`: no mention entity, no reply, not a DM — routeRules can't
    // place it, so it must fall back to the channel's latest session (not be dropped).
    ;(daemon as any).onInbound(tg(200, { text: '/status@mybot' }))
    expect(conn.postChrome).toHaveBeenCalled()
    const [ch, , opts] = conn.postChrome.mock.calls.at(-1)!
    expect(ch).toBe('-100')
    expect(opts).toMatchObject({ replyTo: 200 }) // reply threads under the command message
  })

  it('respects the integration allowedUserIds when falling back', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    ;(daemon as any).agents.get('bot-a').integrations[0].telegram.allowedUserIds = ['999']
    seedSession(daemon, '-100', 'tg:100')
    // Sender U1 (id 'U1') is not in the allow-list → the command is ignored.
    ;(daemon as any).onInbound(tg(200, { text: '/status@mybot' }))
    expect(conn.postChrome).not.toHaveBeenCalled()
    expect(conn.postMessage).not.toHaveBeenCalled()
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
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    seedSession(daemon, '-100', 'tg:100')

    ;(daemon as any).onInbound(tg(200, { text: '/models@mybot' }))
    expect(conn.postCard).toHaveBeenCalled()
    const [ch, , buttons] = conn.postCard.mock.calls.at(-1)!
    expect(ch).toBe('-100')
    expect(buttons).toEqual([[{ text: '✅ opus', callbackData: 'm:0' }], [{ text: 'sonnet', callbackData: 'm:1' }]])
  })

  it('applies the tapped button, acks it, and re-renders the card', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    seedSession(daemon, '-100', 'tg:100')
    const key = sessionKey('telegram', '-100', 'tg:100', 'bot-a')

    ;(daemon as any).handleTelegramCallback(
      { id: 'cb1', data: 'm:1', channel: '-100', messageId: 55, userId: 'U1' },
      conn
    )
    expect((daemon as any).store.getModelOverride(key)).toBe('sonnet')
    expect(conn.answerCallback).toHaveBeenCalledWith('cb1', expect.stringContaining('sonnet'))
    expect(conn.editCard).toHaveBeenCalled()
  })

  it('attributes an applied tap to the tapping user, and records nothing when refused', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = true
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    seedSession(daemon, '-100', 'tg:100')
    const lines: string[] = []
    ;(daemon as any).log = { info: (m: string) => lines.push(m), warn: () => {}, error: () => {}, debug: () => {} }

    ;(daemon as any).handleTelegramCallback(
      { id: 'cb-a', data: 'm:1', channel: '-100', messageId: 55, userId: 'U-DANA' },
      conn
    )
    const applied = lines.filter((l) => l.includes('select:model'))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain('U-DANA')

    // Withdraw chat authority: the next tap changes nothing, so it records nothing.
    ;(daemon as any).agents.get('bot-a').allowRuntimeChangesInChat = false
    lines.length = 0
    ;(daemon as any).handleTelegramCallback(
      { id: 'cb-b', data: 'm:0', channel: '-100', messageId: 55, userId: 'U-DANA' },
      conn
    )
    expect(lines.filter((l) => l.includes('select:model'))).toEqual([])
  })

  it('rejects a tap from a user outside allowedUserIds', async () => {
    const daemon = new Daemon({ root: scaffold() })
    await daemon.start()
    const conn = makeTelegramRoutable(daemon)
    injectHost(daemon)
    ;(daemon as any).agents.get('bot-a').integrations[0].telegram.allowedUserIds = ['999']
    seedSession(daemon, '-100', 'tg:100')

    ;(daemon as any).handleTelegramCallback(
      { id: 'cb2', data: 'm:1', channel: '-100', messageId: 55, userId: 'U1' },
      conn
    )
    expect((daemon as any).store.getModelOverride(sessionKey('telegram', '-100', 'tg:100', 'bot-a'))).toBeUndefined()
    expect(conn.answerCallback).toHaveBeenCalledWith('cb2', expect.stringContaining('No active session'))
    expect(conn.editCard).not.toHaveBeenCalled()
  })
})
