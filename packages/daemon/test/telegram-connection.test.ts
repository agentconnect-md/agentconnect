import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TelegramConnection,
  consolidateTelegram,
  type TelegramBotHandle,
  type TelegramApi,
  type TelegramCallbackQuery,
  type TelegramDeps
} from '../src/telegram/connection.js'
import type { TelegramMessage } from '../src/telegram/normalize.js'
import type { Agent } from '../src/agents/agent-schema.js'

// Capture the options grammY's real Bot.start() receives, so we can assert the
// default factory drops the pending backlog on connect (regression: replayed stale
// @mentions each minted a duplicate session).
const { startSpy } = vi.hoisted(() => ({ startSpy: vi.fn() }))
vi.mock('grammy', () => ({
  Bot: class {
    api = {}
    botInfo = { id: 1, username: 'grammybot' }
    init = vi.fn(async () => {})
    on = vi.fn()
    start = startSpy
    stop = vi.fn(async () => {})
  }
}))

function fakeApi(over: Partial<TelegramApi> = {}): TelegramApi {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 777 })),
    editMessageText: vi.fn(async () => true),
    answerCallbackQuery: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
    setMyCommands: vi.fn(async () => true),
    getChat: vi.fn(async (id) => ({ id: Number(id), type: 'supergroup', title: 'devs', username: 'devschat' })),
    getChatMember: vi.fn(async (_c, uid) => ({ user: { id: uid, username: 'someone' } })),
    getChatAdministrators: vi.fn(async () => [
      { user: { id: 1, first_name: 'Ada', last_name: 'L', is_bot: false } },
      { user: { id: 2, username: 'mybot', is_bot: true } }
    ]),
    getFile: vi.fn(async () => ({ file_path: 'photos/x.jpg', file_size: 12 })),
    ...over
  } as TelegramApi
}

interface BotState {
  onMessage?: (m: TelegramMessage) => void
  onCallbackQuery?: (q: TelegramCallbackQuery) => void
  started: boolean
  stopped: boolean
}

/** A fake bot handle that captures the registered handlers so tests can inject
 *  inbound updates synchronously. */
function fakeBot(api: TelegramApi, botInfo: { id: number; username?: string } = { id: 99, username: 'mybot' }) {
  const state: BotState = { started: false, stopped: false }
  const handle: TelegramBotHandle = {
    api,
    init: vi.fn(async () => {}),
    get botInfo() {
      return botInfo
    },
    onMessage(h) {
      state.onMessage = h
    },
    onCallbackQuery(h) {
      state.onCallbackQuery = h
    },
    start(onStart) {
      state.started = true
      onStart?.()
    },
    stop: vi.fn(async () => {
      state.stopped = true
    })
  }
  return { handle, state }
}

function makeConn(over: Partial<TelegramDeps> = {}, api = fakeApi()) {
  const { handle, state } = fakeBot(api)
  const received: unknown[] = []
  const deps: TelegramDeps = {
    group: { botToken: 'TKN', integrations: [{ agentId: 'a1', integrationId: 'i1' }] },
    onMessage: (m) => received.push(m),
    newTraceId: () => 'trace-x',
    sendIntervalMs: 0,
    ...over
  }
  const conn = new TelegramConnection(deps, () => handle)
  return { conn, state, received, api }
}

afterEach(() => vi.unstubAllGlobals())

describe('consolidateTelegram', () => {
  it('groups integrations by bot token, ignoring non-telegram platforms', () => {
    const agents: Agent[] = [
      {
        id: 'a1',
        integrations: [
          { id: 'i1', platform: 'telegram', core: { bindRules: [] }, config: { botToken: 'T1' } },
          { id: 'i2', platform: 'slack', core: { bindRules: [] }, config: { botToken: 'x', appToken: 'y' } }
        ]
      } as unknown as Agent,
      {
        id: 'a2',
        integrations: [{ id: 'i3', platform: 'telegram', core: { bindRules: [] }, config: { botToken: 'T1' } }]
      } as unknown as Agent
    ]
    const groups = consolidateTelegram(agents)
    expect([...groups.keys()]).toEqual(['T1'])
    expect(groups.get('T1')!.integrations).toEqual([
      { agentId: 'a1', integrationId: 'i1' },
      { agentId: 'a2', integrationId: 'i3' }
    ])
  })
})

describe('TelegramConnection.start', () => {
  it('resolves bot identity via getMe, registers the handler, advertises commands, and starts long-poll', async () => {
    const { conn, state, api } = makeConn()
    await conn.start()
    expect(conn.botUserId).toBe('99')
    expect(conn.botUsername).toBe('mybot')
    expect(state.started).toBe(true)
    expect(typeof state.onMessage).toBe('function')
    // The slash-command menu is registered so the commands autocomplete.
    const commands = (api.setMyCommands as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { command: string }[]
    expect(commands.map((c) => c.command)).toEqual([
      'status',
      'stop',
      'cancel',
      'resume',
      'fast',
      'models',
      'effort',
      'permission',
      'queue'
    ])
  })

  it('drops the pending backlog on connect (default grammY factory)', async () => {
    startSpy.mockClear()
    // No injected factory → exercises defaultFactory, which builds the mocked grammY Bot.
    const conn = new TelegramConnection({
      group: { botToken: 'TKN', integrations: [{ agentId: 'a1', integrationId: 'i1' }] },
      onMessage: () => {},
      newTraceId: () => 'trace-x',
      sendIntervalMs: 0
    })
    await conn.start()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]![0]).toMatchObject({ drop_pending_updates: true })
  })

  it('start() survives a setMyCommands failure (best-effort menu)', async () => {
    const { conn, state } = makeConn(
      {},
      fakeApi({
        setMyCommands: vi.fn(async () => {
          throw new Error('flood wait')
        })
      })
    )
    await expect(conn.start()).resolves.toBeUndefined()
    expect(state.started).toBe(true)
  })

  it('normalizes an inbound message and forwards it to onMessage', async () => {
    const { conn, state, received } = makeConn()
    await conn.start()
    state.onMessage!({
      message_id: 5,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 3, username: 'ada' },
      text: 'hi'
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ platform: 'telegram', channel: '-100', text: 'hi', sender: { id: '3' } })
  })

  it('observes the chat when this bot is added but never forwards membership service messages', async () => {
    const onBotAddedToChat = vi.fn()
    const { conn, state, received } = makeConn({ onBotAddedToChat })
    await conn.start()

    state.onMessage!({
      message_id: 5,
      chat: { id: -100, type: 'supergroup', title: 'private group' },
      from: { id: 3, username: 'ada' },
      new_chat_members: [{ id: 99, is_bot: true, username: 'mybot' }]
    })
    state.onMessage!({
      message_id: 6,
      chat: { id: -100, type: 'supergroup', title: 'private group' },
      from: { id: 3, username: 'ada' },
      new_chat_members: [{ id: 4, username: 'grace' }]
    })
    state.onMessage!({
      message_id: 7,
      chat: { id: -100, type: 'supergroup', title: 'private group' },
      from: { id: 3, username: 'ada' },
      left_chat_member: { id: 4, username: 'grace' }
    })

    expect(received).toHaveLength(0)
    expect(onBotAddedToChat).toHaveBeenCalledOnce()
    expect(onBotAddedToChat).toHaveBeenCalledWith({
      id: '-100',
      name: 'private group',
      isPrivate: true
    })
  })
})

describe('TelegramConnection outbound chrome', () => {
  it('postChrome sends with parse_mode + forum topic and returns the message id', async () => {
    const { conn, api } = makeConn()
    const id = await conn.postChrome('-100', '<b>hi</b>', { parseMode: 'HTML', threadTs: '42' })
    expect(api.sendMessage).toHaveBeenCalledWith('-100', '<b>hi</b>', { parse_mode: 'HTML', message_thread_id: 42 })
    expect(id).toBe('777')
  })

  it('updateMessage edits in place, swallowing errors best-effort', async () => {
    const { conn, api } = makeConn()
    await conn.updateMessage('-100', '777', '🔨 <code>ls</code>', { parseMode: 'HTML' })
    expect(api.editMessageText).toHaveBeenCalledWith('-100', 777, '🔨 <code>ls</code>', { parse_mode: 'HTML' })

    const boom = makeConn(
      {},
      fakeApi({
        editMessageText: vi.fn(async () => {
          throw new Error('msg not modified')
        })
      })
    )
    await expect(boom.conn.updateMessage('-100', '1', 'x')).resolves.toBeUndefined()
  })

  it('sendChatAction fires a typing hint', async () => {
    const { conn, api } = makeConn()
    await conn.sendChatAction('-100')
    expect(api.sendChatAction).toHaveBeenCalledWith('-100', 'typing')
  })
})

describe('TelegramConnection gateway', () => {
  it('postMessage maps a numeric thread to message_thread_id and returns the message id', async () => {
    const { conn, api } = makeConn()
    const id = await conn.postMessage('-100', 'yo', '555')
    expect(api.sendMessage).toHaveBeenCalledWith('-100', 'yo', { message_thread_id: 555 })
    expect(id).toBe('777')
  })

  it('postMessage omits message_thread_id when no thread is given', async () => {
    const { conn, api } = makeConn()
    await conn.postMessage('-100', 'yo')
    expect(api.sendMessage).toHaveBeenCalledWith('-100', 'yo', {})
  })

  it('getChannelInfo maps a supergroup with a username (public → not private, not IM)', async () => {
    const { conn } = makeConn()
    const info = await conn.getChannelInfo('-100')
    expect(info).toEqual({ id: '-100', name: 'devs', isIm: false, isPrivate: false })
  })

  it('getChannelInfo labels a private chat from first/last name when there is no username', async () => {
    const { conn } = makeConn(
      {},
      fakeApi({
        getChat: vi.fn(async () => ({ id: 42, type: 'private', first_name: 'Ada', last_name: 'Lovelace' }))
      })
    )
    expect(await conn.getChannelInfo('42')).toEqual({
      id: '42',
      name: 'Ada Lovelace',
      isIm: true,
      isPrivate: true
    })
  })

  it('listMembers returns administrators (id/name/isBot), best-effort []', async () => {
    const { conn } = makeConn()
    expect(await conn.listMembers('-100')).toEqual([
      { id: '1', name: 'Ada L', isBot: false },
      { id: '2', name: 'mybot', isBot: true }
    ])

    const failing = makeConn(
      {},
      fakeApi({
        getChatAdministrators: vi.fn(async () => {
          throw new Error('forbidden')
        })
      })
    )
    expect(await failing.conn.listMembers('-100')).toEqual([])
  })

  it('listChannels is always [] (a bot cannot enumerate its chats)', async () => {
    const { conn } = makeConn()
    expect(await conn.listChannels()).toEqual([])
  })

  it('getUserProfile degrades to echoing the id', async () => {
    const { conn } = makeConn()
    expect(await conn.getUserProfile('42')).toEqual({ id: '42' })
  })
})

describe('TelegramConnection.downloadFile', () => {
  it('resolves file_id → getFile → fetch and returns the bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    )
    const { conn, api } = makeConn()
    const buf = await conn.downloadFile('FILEID')
    expect(api.getFile).toHaveBeenCalledWith('FILEID')
    expect(fetch).toHaveBeenCalledWith('https://api.telegram.org/file/botTKN/photos/x.jpg')
    expect(buf && [...buf]).toEqual([1, 2, 3])
  })

  it('returns null when getFile yields no file_path', async () => {
    const { conn } = makeConn({}, fakeApi({ getFile: vi.fn(async () => ({})) }))
    expect(await conn.downloadFile('X')).toBeNull()
  })

  it('returns null when the declared size exceeds the cap', async () => {
    const { conn } = makeConn({}, fakeApi({ getFile: vi.fn(async () => ({ file_path: 'p', file_size: 10_000 })) }))
    expect(await conn.downloadFile('X', 100)).toBeNull()
  })

  it('returns null on a non-OK HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    )
    const { conn } = makeConn()
    expect(await conn.downloadFile('X')).toBeNull()
  })
})
