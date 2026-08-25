import { afterEach, describe, it, expect, vi } from 'vitest'
import { encodeSlackStatusOverflowValue, SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID } from '@agentconnect.md/protocol'
import { SLACK_RESPONSE_FINAL_EVENT_TAG } from '@agentconnect.md/message'
import { consolidate, SlackConnection } from '../src/slack/connection.js'
import type { Agent } from '../src/agents/agent-schema.js'

const mk = (id: string, appToken: string, botToken: string): Agent =>
  ({
    id,
    name: id,
    status: 'active',
    runtime: 'claude',
    workspace: { mode: 'from-scratch', path: '/tmp', gitBranch: 'main', pullOnNewSession: true, skills: [] },
    integrations: [
      {
        id: `${id}-int`,
        platform: 'slack',
        core: { bindRules: [] },
        config: { botToken, appToken }
      }
    ],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: []
  }) as unknown as Agent

describe('consolidate', () => {
  it('opens one connection per unique appToken and groups integrations', () => {
    const appToken = 'xapp-1-A123-456-secret'
    const groups = consolidate([mk('a', appToken, 'xoxb-a'), mk('b', appToken, 'xoxb-a'), mk('c', 'xapp-2', 'xoxb-c')])
    expect(groups.size).toBe(2)
    expect(groups.get(appToken)).toMatchObject({ appId: 'A123', integrations: expect.any(Array) })
    expect(groups.get(appToken)!.integrations).toHaveLength(2)
    expect(groups.get('xapp-2')!.integrations).toHaveLength(1)
  })
})

// `apiCall` is the generic Web-API entry the untyped `agents.sessions.*` methods go through.
function fakeAppWith(
  setStatus: (a: any) => Promise<unknown>,
  apiCall: (method: string, a: any) => Promise<unknown> = async () => ({}),
  postMessage: (a: any) => Promise<unknown> = async () => ({})
) {
  return {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
      chat: { postMessage, getPermalink: async () => ({ permalink: 'https://example.slack.com/thread' }) },
      assistant: { threads: { setStatus } },
      apiCall
    },
    start: async () => {},
    stop: async () => {}
  }
}

const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

describe('SlackConnection initialization', () => {
  it('constructs the Bolt v5 Socket Mode receiver', () => {
    expect(() => new SlackConnection(deps() as any)).not.toThrow()
  })

  it('applies the bounded Web API policy to the app and Socket Mode receiver', () => {
    const app = (new SlackConnection(deps() as any) as any).app
    const receiverWebClient = app.receiver.client.webClient

    expect(app.client.retryConfig).toMatchObject({ retries: 2 })
    expect(app.client.timeout).toBe(30_000)
    expect(receiverWebClient.retryConfig).toMatchObject({ retries: 2 })
    expect(receiverWebClient.timeout).toBe(30_000)
  })

  it('caches Bolt authorization across repeated events', async () => {
    const conn = new SlackConnection(deps() as any)
    const app = (conn as any).app
    const authTest = vi.fn(async () => ({
      ok: true,
      user_id: 'UBOT',
      bot_id: 'BBOT',
      url: 'https://example.slack.com/'
    }))
    app.client.auth.test = authTest
    app.start = vi.fn(async () => undefined)

    await conn.start()
    expect(authTest).toHaveBeenCalledTimes(2)

    await app.authorize({ isEnterpriseInstall: false })
    await app.authorize({ isEnterpriseInstall: false })
    expect(authTest).toHaveBeenCalledTimes(2)
  })
})

describe('SlackConnection.downloadFile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the bot token only to canonical Slack file URLs and disables redirects', async () => {
    const fetchMock = vi.fn(async () => new Response('file contents', { headers: { 'content-type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetchMock)
    const conn = new SlackConnection(deps() as any, () => fakeAppWith(async () => undefined) as any)
    const url = 'https://files.slack.com/files-pri/T0123-F0456/download/note.txt'

    await expect(conn.downloadFile(url)).resolves.toEqual(Buffer.from('file contents'))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Bearer xoxb-a' },
      redirect: 'error'
    })
  })

  it('rejects URL confusion and off-origin destinations before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const conn = new SlackConnection(deps() as any, () => fakeAppWith(async () => undefined) as any)

    for (const url of [
      'not a URL',
      'blob:https://files.slack.com/files-pri/T-F/file',
      'http://files.slack.com/files-pri/T-F/file',
      'https://files.slack.com.evil.example/files-pri/T-F/file',
      'https://user@files.slack.com/files-pri/T-F/file',
      'https://files.slack.com:8443/files-pri/T-F/file',
      'https://attacker.example/file'
    ]) {
      await expect(conn.downloadFile(url)).resolves.toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('SlackConnection.openDirectMessage', () => {
  it('resolves a Slack member to the app DM channel', async () => {
    const open = vi.fn(async () => ({ channel: { id: 'D123' } }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { conversations: { open } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.openDirectMessage('U123')).resolves.toBe('D123')
    expect(open).toHaveBeenCalledWith({ users: 'U123' })
  })
})

describe('SlackConnection.listBotChannels', () => {
  const fakeAppWithConversations = (pages: any[], fail = false) => {
    let call = 0
    return {
      message() {},
      event() {},
      action() {},
      shortcut() {},
      client: {
        auth: { test: async () => ({ user_id: 'U1' }) },
        users: {
          conversations: async () => {
            if (fail) throw new Error('missing_scope')
            return pages[call++] ?? { channels: [] }
          }
        }
      },
      start: async () => {},
      stop: async () => {}
    }
  }

  it('paginates users.conversations and maps to {id,name,isPrivate}, skipping DMs', async () => {
    const conn = new SlackConnection(
      deps() as any,
      () =>
        fakeAppWithConversations([
          {
            channels: [
              { id: 'C1', name: 'deploys' },
              { id: 'D1', is_im: true }, // DM — excluded
              { id: 'C2', name: 'ops', is_private: true }
            ],
            response_metadata: { next_cursor: 'page2' }
          },
          { channels: [{ id: 'C3', name: 'releases' }] }
        ]) as any
    )
    const channels = await conn.listBotChannels()
    expect(channels).toEqual([
      { id: 'C1', name: 'deploys' },
      { id: 'C2', name: 'ops', isPrivate: true },
      { id: 'C3', name: 'releases' }
    ])
  })

  it('returns null on an API failure (never mistaken for "left all channels")', async () => {
    const conn = new SlackConnection(deps() as any, () => fakeAppWithConversations([], true) as any)
    expect(await conn.listBotChannels()).toBeNull()
  })

  it('uses bot membership for listChannels instead of workspace-wide conversations.list', async () => {
    const conversationsList = vi.fn(async () => {
      throw new Error('conversations.list should not be called')
    })
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'U1' }) },
            users: {
              conversations: async () => ({
                channels: [
                  { id: 'C1', name: 'joined-public' },
                  { id: 'C2', name: 'joined-private', is_private: true }
                ]
              })
            },
            conversations: { list: conversationsList }
          },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.listChannels()).resolves.toEqual([
      { id: 'C1', name: 'joined-public' },
      { id: 'C2', name: 'joined-private', isPrivate: true }
    ])
    expect(conversationsList).not.toHaveBeenCalled()
  })
})

describe('SlackConnection.getThreadReplies', () => {
  it('can surface snapshot failures to the turn-final refresh caller', async () => {
    const replies = vi.fn(async () => {
      throw Object.assign(new Error('rate_limited'), { code: 'slack_webapi_rate_limited' })
    })
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.getThreadReplies('C1', '100.1', 200, { throwOnError: true })).rejects.toThrow('rate_limited')
  })

  it('marks a bounded snapshot as truncated when provider rows remain', async () => {
    const replies = vi.fn(async () => ({
      messages: [
        { ts: '100.2', user: 'U1', text: 'first' },
        { ts: '100.3', user: 'U1', text: 'second' }
      ],
      has_more: false
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )
    const readState = { truncated: false }

    await expect(conn.getThreadReplies('C1', '100.1', 1, { readState })).resolves.toHaveLength(1)
    expect(readState.truncated).toBe(true)
  })

  it('bounds an incremental thread snapshot by the delivered watermark and wall-clock cutoff', async () => {
    const replies = vi.fn(async () => ({
      messages: [{ ts: '100.3', user: 'U1', text: 'latest unread' }],
      has_more: false
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await conn.getThreadReplies('C1', '100.1', 200, { oldest: '100.2', latest: '100.4' })
    expect(replies).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '100.1',
      limit: 200,
      include_all_metadata: true,
      oldest: '100.2',
      latest: '100.4',
      inclusive: false
    })
  })

  it('recovers an AgentConnect author id from shared-bot message metadata', async () => {
    const replies = vi.fn(async () => ({
      messages: [
        {
          ts: '100.3',
          user: 'USHARED',
          bot_id: 'BSHARED',
          app_id: 'AAGENTCONNECT',
          text: '@agent-a → @agent-b: review this',
          metadata: {
            event_type: 'agentconnect_thread_event',
            event_payload: { author_agent_id: 'agent-a' }
          }
        }
      ],
      has_more: false
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.getThreadReplies('C1', '100.1')).resolves.toEqual([
      expect.objectContaining({
        sender: 'BSHARED',
        agentAuthorId: 'agent-a',
        appId: 'AAGENTCONNECT',
        isBot: true
      })
    ])
  })

  it('recovers visible legacy attachment text when backfilling a thread', async () => {
    const replies = vi.fn(async () => ({
      messages: [
        {
          ts: '100.2',
          bot_id: 'BCHANGELOGUE',
          text: '<@UBOT>',
          attachments: [
            {
              title: 'reth v2.4.0',
              title_link: 'https://example.test/reth/releases/v2.4.0',
              text: 'Performance improvements',
              actions: [{ type: 'button', text: 'Acknowledge' }]
            }
          ]
        }
      ],
      has_more: false
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    const [message] = await conn.getThreadReplies('C1', '100.1')
    expect(message?.text).toContain('<https://example.test/reth/releases/v2.4.0|reth v2.4.0>')
    expect(message?.text).toContain('Performance improvements')
    expect(message?.text).not.toContain('Acknowledge')
  })

  it('flags daemon chrome from its metadata event_type so the backfill can skip it', async () => {
    const replies = vi.fn(async () => ({
      messages: [
        {
          ts: '100.2',
          bot_id: 'BSHARED',
          text: ':bar_chart: opus',
          metadata: { event_type: 'agentconnect_chrome', event_payload: { owner_agent_id: 'agent-a' } }
        },
        { ts: '100.3', user: 'U1', text: 'a human message' }
      ],
      has_more: false
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { replies } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.getThreadReplies('C1', '100.1')).resolves.toEqual([
      expect.objectContaining({ ts: '100.2', chrome: true, chromeOwnerAgentId: 'agent-a' }),
      expect.objectContaining({ ts: '100.3', chrome: false })
    ])
  })
})

describe('SlackConnection.getChannelHistory', () => {
  it('forwards the official cursor and time bounds and returns one page', async () => {
    const history = vi.fn(async () => ({
      messages: [
        { ts: '100.5', user: 'U1', text: 'latest', thread_ts: '100.1', reply_count: 2 },
        { ts: '100.4', bot_id: 'B1', text: 'bot message' }
      ],
      has_more: true,
      response_metadata: { next_cursor: 'next-page' }
    }))
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { history } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(
      conn.getChannelHistory('C1', { cursor: 'previous-page', limit: 2, oldest: '100.0', latest: '100.5' })
    ).resolves.toEqual({
      messages: [
        { sender: 'U1', ts: '100.5', text: 'latest', isBot: false, threadTs: '100.1', replyCount: 2 },
        { sender: 'B1', ts: '100.4', text: 'bot message', isBot: true }
      ],
      hasMore: true,
      nextCursor: 'next-page'
    })
    expect(history).toHaveBeenCalledWith({
      channel: 'C1',
      cursor: 'previous-page',
      limit: 2,
      oldest: '100.0',
      latest: '100.5',
      inclusive: true
    })
  })

  it('surfaces a bounded Slack API error code to the caller', async () => {
    const history = vi.fn(async () => {
      throw { data: { error: 'missing_scope' } }
    })
    const conn = new SlackConnection(
      deps() as any,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: { auth: { test: async () => ({ user_id: 'UBOT' }) }, conversations: { history } },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await expect(conn.getChannelHistory('C1')).rejects.toThrow('Slack channel history failed: missing_scope')
  })
})

describe('SlackConnection membership events', () => {
  const fakeAppWithEvents = (
    handlers: Map<string, (a: { event: unknown }) => unknown>,
    actions?: Map<string, (a: any) => unknown>,
    opened?: any[],
    shortcuts?: Map<string, (a: any) => unknown>
  ) => ({
    message() {},
    event(type: string, h: (a: { event: unknown }) => unknown) {
      handlers.set(type, h)
    },
    action(id: string, h: (a: any) => unknown) {
      actions?.set(id, h)
    },
    shortcut(id: string, h: (a: any) => unknown) {
      shortcuts?.set(id, h)
    },
    client: {
      auth: { test: async () => ({ user_id: 'UBOT' }) },
      views: { open: async (a: any) => void opened?.push(a), update: async () => {} }
    },
    start: async () => {},
    stop: async () => {}
  })

  it('fires onChannelsChanged when the BOT joins, and on channel_left/group_left', async () => {
    const handlers = new Map<string, (a: { event: unknown }) => unknown>()
    let changed = 0
    const conn = new SlackConnection(
      { ...deps(), onChannelsChanged: () => changed++ } as any,
      () => fakeAppWithEvents(handlers) as any
    )
    await conn.start()
    // Another user joining is NOT a membership change for us.
    await handlers.get('member_joined_channel')!({ event: { user: 'USOMEONE', channel: 'C1' } })
    expect(changed).toBe(0)
    await handlers.get('member_joined_channel')!({ event: { user: 'UBOT', channel: 'C1' } })
    expect(changed).toBe(1)
    await handlers.get('channel_left')!({ event: { channel: 'C1' } })
    await handlers.get('group_left')!({ event: { channel: 'G1' } })
    expect(changed).toBe(3)
  })

  it('acknowledges the permission-update URL button', async () => {
    const actions = new Map<string, (a: any) => unknown>()
    const conn = new SlackConnection(deps() as any, () => fakeAppWithEvents(new Map(), actions) as any)
    await conn.start()
    const ack = vi.fn(async () => {})
    await actions.get('ac_update_permissions')!({ ack, action: {} })
    expect(ack).toHaveBeenCalledOnce()
  })

  it('opens the controls modal on Configure and routes status actions by session key', async () => {
    const KEY = 'slack:C1:T1:bot-a'
    const handlers = new Map<string, (a: { event: unknown }) => unknown>()
    const actions = new Map<string, (a: any) => unknown>()
    const opened: any[] = []
    const seen: { kind: string; sessionKey: string; model?: string }[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        onStatusAction: (a: any) => seen.push(a),
        onStatusInfo: (k: string) => ({
          info: { model: 'opus-4.8', models: ['opus-4.8'] },
          identity: {
            name: 'Review Bot',
            agentUrl: 'https://app/agents/review-bot',
            iconUrl: 'https://app/icons/review-bot.png',
            sessionTitle: 'Fix login flow'
          },
          link: `https://app/s/${k}`,
          cancellable: true
        })
      } as any,
      () => fakeAppWithEvents(handlers, actions, opened) as any
    )
    await conn.start()
    const ack = async () => {}

    // Configure: opens a modal (via trigger_id) carrying the session key in private_metadata.
    await actions.get('ac_manage')!({ ack, action: { value: KEY }, body: { trigger_id: 'trig-1' } })
    expect(opened).toHaveLength(1)
    expect(opened[0].trigger_id).toBe('trig-1')
    expect(opened[0].view.private_metadata).toBe(KEY)
    expect(opened[0].view.blocks[0]).toEqual({
      type: 'context',
      elements: [
        { type: 'image', image_url: 'https://app/icons/review-bot.png', alt_text: 'Review Bot' },
        { type: 'mrkdwn', text: '<https://app/agents/review-bot|Review Bot> ·' },
        { type: 'mrkdwn', text: `<https://app/s/${KEY}|View session>` }
      ]
    })
    expect(opened[0].view.title.text).toBe('Session · Fix login flow')

    // The compact overflow uses the same modal and cancel paths.
    await actions.get('ac_more')!({
      ack,
      action: { block_id: KEY, selected_option: { value: encodeSlackStatusOverflowValue('manage') } },
      body: { trigger_id: 'trig-2' }
    })
    expect(opened).toHaveLength(2)
    expect(opened[1].view.private_metadata).toBe(KEY)
    await actions.get('ac_more')!({
      ack,
      action: { selected_option: { value: JSON.stringify({ v: 1, action: 'manage', target: KEY }) } },
      body: { trigger_id: 'trig-legacy' }
    })
    expect(opened).toHaveLength(3)
    expect(opened[2].view.private_metadata).toBe(KEY)
    await actions.get('ac_more')!({
      ack,
      action: { block_id: KEY, selected_option: { value: encodeSlackStatusOverflowValue('cancel') } },
      body: {}
    })

    // Inside the modal, the session key comes from view.private_metadata.
    await actions.get('ac_set_model')!({
      ack,
      action: { selected_option: { value: 'opus-4.8' } },
      body: { view: { id: 'V1', private_metadata: KEY } }
    })
    await actions.get('ac_cancel')!({ ack, action: {}, body: { view: { id: 'V1', private_metadata: KEY } } })

    expect(seen).toEqual([
      { kind: 'cancel', sessionKey: KEY },
      { kind: 'set-model', sessionKey: KEY, model: 'opus-4.8' },
      { kind: 'cancel', sessionKey: KEY }
    ])
  })

  it('opens the selected conversation session from the message shortcut', async () => {
    const KEY = 'slack:C1:T1:bot-a'
    const shortcuts = new Map<string, (a: any) => unknown>()
    const opened: any[] = []
    const resolve = vi.fn().mockReturnValueOnce(KEY).mockReturnValueOnce(undefined)
    const conn = new SlackConnection(
      {
        ...deps(),
        onMessageShortcut: resolve,
        onStatusInfo: (key: string) => ({
          info: { model: 'opus-4.8' },
          link: `https://app/s/${key}`,
          cancellable: false
        })
      } as any,
      () => fakeAppWithEvents(new Map(), new Map(), opened, shortcuts) as any
    )
    await conn.start()
    const handler = shortcuts.get(SLACK_MANAGE_SESSION_SHORTCUT_CALLBACK_ID)!
    const ack = vi.fn(async () => {})

    await handler({
      ack,
      shortcut: {
        trigger_id: 'trig-shortcut',
        channel: { id: 'C1' },
        message: { ts: 'T1.2', thread_ts: 'T1' },
        user: { id: 'U1' }
      }
    })

    expect(ack).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledWith({ channel: 'C1', thread: 'T1', userId: 'U1' })
    expect(opened[0]).toMatchObject({
      trigger_id: 'trig-shortcut',
      view: { private_metadata: KEY }
    })

    await handler({
      ack: async () => {},
      shortcut: {
        trigger_id: 'trig-missing',
        channel: { id: 'C2' },
        message: { ts: 'T2' },
        user: { id: 'U1' }
      }
    })
    expect(opened[1]).toMatchObject({
      trigger_id: 'trig-missing',
      view: {
        title: { text: 'Session options' },
        blocks: [{ text: { text: 'No AgentConnect session was found for this conversation.' } }]
      }
    })
  })

  it('openStatusModal lets a forwarded shared click override view.private_metadata', async () => {
    const KEY = 'slack:C1:T1:bot-a'
    const TARGET = JSON.stringify({ v: 1, agentId: 'bot-a', integrationId: 'int-a', sessionKey: KEY })
    const opened: any[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        onStatusInfo: (k: string) => ({
          info: { model: 'opus-4.8' },
          link: `https://app/s/${k}`,
          cancellable: true
        })
      } as any,
      () => fakeAppWithEvents(new Map(), new Map(), opened) as any
    )

    await conn.openStatusModal('trig-shared', KEY, TARGET)

    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      trigger_id: 'trig-shared',
      view: { private_metadata: TARGET }
    })
  })
})

describe('SlackConnection assistant DM threads', () => {
  it('rebases DM message events onto the active assistant thread', async () => {
    let messageHandler!: (a: { message: unknown }) => unknown
    const events = new Map<string, (a: { event: unknown }) => unknown>()
    const delivered: unknown[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        onMessage: (msg: unknown) => delivered.push(msg)
      } as any,
      () =>
        ({
          message(h: (a: { message: unknown }) => unknown) {
            messageHandler = h
          },
          event(type: string, h: (a: { event: unknown }) => unknown) {
            events.set(type, h)
          },
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'UBOT' }) },
            views: { open: async () => {}, update: async () => {} }
          },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await conn.start()
    await events.get('assistant_thread_started')!({
      event: {
        type: 'assistant_thread_started',
        assistant_thread: {
          user_id: 'U1',
          channel_id: 'D1',
          thread_ts: '1729999327.187299'
        }
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        ts: '1730000000.000001',
        user: 'U1',
        text: 'hello'
      }
    })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      channel: 'D1',
      thread: '1729999327.187299',
      isDm: true,
      text: 'hello'
    })
  })

  it('ignores structural and Slack system events while retaining human and peer-bot chat', async () => {
    let messageHandler!: (a: { message: unknown }) => unknown
    const delivered: any[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        onMessage: (msg: unknown) => delivered.push(msg)
      } as any,
      () =>
        ({
          message(h: (a: { message: unknown }) => unknown) {
            messageHandler = h
          },
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BSELF' }) },
            views: { open: async () => {}, update: async () => {} }
          },
          start: async () => {},
          stop: async () => {}
        }) as any
    )

    await conn.start()
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'message_changed',
        hidden: true,
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484103.018100',
        message: {
          type: 'message',
          subtype: 'assistant_app_thread',
          user: 'UBOT',
          text: 'Updated title',
          thread_ts: '1727484091.821349',
          ts: '1727484091.821349'
        }
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'message_deleted',
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484104.000000'
      }
    })
    // Slack documents that Events API message_replied wrappers can omit subtype.
    // Hidden+nested shape and the lack of a top-level author must still exclude it.
    await messageHandler({
      message: {
        type: 'message',
        hidden: true,
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484104.500000',
        message: {
          type: 'message',
          user: 'U1',
          text: 'thread root update',
          thread_ts: '1727484091.821349',
          ts: '1727484091.821349'
        }
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'assistant_app_thread',
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484105.000000',
        user: 'U1',
        text: 'thread metadata'
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484105.500000',
        user: 'USLACK',
        text: '<@U1> added you to <#C1>.'
      }
    })
    expect(delivered).toEqual([])

    await messageHandler({
      message: {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484106.000000',
        user: 'U1',
        text: 'hello'
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'file_share',
        channel: 'D1',
        channel_type: 'im',
        ts: '1727484107.000000',
        user: 'U1',
        text: 'see attachment'
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'thread_broadcast',
        channel: 'C1',
        ts: '1727484108.000000',
        thread_ts: '1727484000.000000',
        user: 'U1',
        text: 'also send to channel'
      }
    })
    await messageHandler({
      message: {
        type: 'message',
        subtype: 'me_message',
        channel: 'C1',
        ts: '1727484109.000000',
        user: 'U1',
        text: 'is checking the deployment'
      }
    })
    const botMessage = { type: 'message', subtype: 'bot_message', channel: 'C1' }
    await messageHandler({
      message: { ...botMessage, ts: '1727484109.500000', bot_id: 'BSELF', text: 'self echo' }
    })
    await messageHandler({
      message: { ...botMessage, ts: '1727484110.000000', bot_id: 'BPEER', text: 'peer bot update' }
    })

    expect(delivered.map((msg) => msg.text)).toEqual([
      'hello',
      'see attachment',
      'also send to channel',
      'is checking the deployment',
      'peer bot update'
    ])
  })

  it('recognizes a stop-time finalization on the bot own message, past own-echo (streaming §3.3/§7.1)', async () => {
    // A native streamed turn closes its response on `chat.stopStream`, which emits no
    // `message_changed` edit — the finalized message arrives as an ordinary bot message carrying
    // the SAME `final` metadata. It must route despite being the bot's own post, or agent-to-agent
    // routing stops on the shareable bots that stream; a mid-stream `streaming` post still drops.
    let messageHandler!: (a: { message: unknown }) => unknown
    const delivered: any[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        onMessage: (msg: unknown) => delivered.push(msg)
      } as any,
      () =>
        ({
          message(h: (a: { message: unknown }) => unknown) {
            messageHandler = h
          },
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BSELF' }) },
            views: { open: async () => {}, update: async () => {} }
          },
          start: async () => {},
          stop: async () => {}
        }) as any
    )
    await conn.start()

    const streamedFinal = (deliveryState: 'streaming' | 'final', ts: string) => ({
      message: {
        type: 'message',
        channel: 'C1',
        ts,
        thread_ts: '1727484200.000000',
        bot_id: 'BSELF',
        app_id: 'AMANAGED',
        text: '<@UPEER> please verify the rollout',
        metadata: {
          event_type: 'agentconnect_thread_event',
          event_payload: {
            author_agent_id: 'agent-author',
            response_id: 'r-1',
            delivery_state: deliveryState,
            hop_count: 2,
            mentioned_agent_ids: ['agent-peer']
          }
        }
      }
    })

    // Mid-stream: dropped by own-echo exactly as before.
    await messageHandler(streamedFinal('streaming', '1727484201.000000'))
    expect(delivered).toEqual([])

    // The stop: recognized as the finalization even though it is the bot's own message.
    await messageHandler(streamedFinal('final', '1727484202.000000'))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].ingressEventTag).toBe(SLACK_RESPONSE_FINAL_EVENT_TAG)
    expect(delivered[0].agentAuthorship?.authorAgentId).toBe('agent-author')
    expect(delivered[0].agentAuthorship?.mentionedAgentIds).toEqual(['agent-peer'])
    expect(delivered[0].msgId).toBe('slack:C1:1727484202.000000')
  })
})

describe('SlackConnection.setStatus', () => {
  it('maps args to assistant.threads.setStatus including loading messages and agent identity', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(deps() as any, () => fakeAppWith(async (a) => void calls.push(a)) as any)
    await conn.setStatus('C1', '123.45', 'is thinking…', ['Working on it…'], {
      username: '  Release Captain  ',
      icon_url: '  https://console.example.test/icons/bot-a  '
    })
    expect(calls[0]).toEqual({
      channel_id: 'C1',
      thread_ts: '123.45',
      status: 'is thinking…',
      loading_messages: ['Working on it…'],
      username: 'Release Captain',
      icon_url: 'https://console.example.test/icons/bot-a'
    })
  })

  it('omits loading messages and identity when clearing', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(deps() as any, () => fakeAppWith(async (a) => void calls.push(a)) as any)
    await conn.setStatus('C1', '123.45', '', undefined, {
      username: 'Release Captain',
      icon_url: 'https://console.example.test/icons/bot-a'
    })
    expect(calls[0]).toEqual({ channel_id: 'C1', thread_ts: '123.45', status: '' })
  })

  it('swallows errors and never rejects (best-effort)', async () => {
    const conn = new SlackConnection(
      deps() as any,
      () =>
        fakeAppWith(async () => {
          throw new Error('not_an_assistant_thread')
        }) as any
    )
    await expect(conn.setStatus('C1', '123.45', 'is thinking…')).resolves.toBeUndefined()
  })

  // The free-text call and the lifecycle enum are two halves of one status: the enum drives
  // the native loading UX (and the stop button), the free text is what the user reads.
  const lifecycleConn = (record: (a: any) => void, setStatus: (a: any) => Promise<unknown> = async () => undefined) =>
    new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        fakeAppWith(setStatus, async (method, a) => {
          if (method === 'agents.sessions.setStatus') record(a)
          return {}
        }) as any
    )

  it('mirrors the free-text status with the agent-session lifecycle enum', async () => {
    const lifecycle: any[] = []
    const conn = lifecycleConn((a) => lifecycle.push(a))

    await conn.setStatus('C1', '123.45', 'is thinking…', ['Working on it…'], {
      username: 'Release Captain',
      icon_url: 'https://console.example.test/icons/bot-a'
    })
    await conn.setStatus('C1', '123.45', '')

    // No username/icon here on purpose: Slack keeps those sticky on an agent session until
    // cleared, so the per-agent identity stays on the free-text call.
    expect(lifecycle).toEqual([
      { channel_id: 'C1', thread_ts: '123.45', status: 'processing' },
      { channel_id: 'C1', thread_ts: '123.45', status: 'active' }
    ])
  })

  it('refires nothing for an unchanged lifecycle state, per channel and thread', async () => {
    const lifecycle: any[] = []
    const conn = lifecycleConn((a) => lifecycle.push(a))

    await conn.setStatus('C1', '123.45', 'is thinking…')
    await conn.setStatus('C1', '123.45', 'Searching…')
    await conn.setStatus('C1', '999.99', 'is thinking…')
    await conn.setStatus('C1', '123.45', '')
    await conn.setStatus('C1', '123.45', '')

    expect(lifecycle).toEqual([
      { channel_id: 'C1', thread_ts: '123.45', status: 'processing' },
      { channel_id: 'C1', thread_ts: '999.99', status: 'processing' },
      { channel_id: 'C1', thread_ts: '123.45', status: 'active' }
    ])
  })

  it('retries a lifecycle state the last call failed on rather than deduping the failure', async () => {
    const lifecycle: any[] = []
    let attempts = 0
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        fakeAppWith(
          async () => undefined,
          async (method, a) => {
            if (method !== 'agents.sessions.setStatus') return {}
            if (++attempts === 1) throw new Error('ratelimited')
            lifecycle.push(a)
            return {}
          }
        ) as any
    )

    await conn.setStatus('C1', '123.45', 'is thinking…')
    await conn.setStatus('C1', '123.45', 'Searching…')

    expect(lifecycle).toEqual([{ channel_id: 'C1', thread_ts: '123.45', status: 'processing' }])
  })

  // The relay forwards the native stop to the owning daemon, so an HTTP bot can answer the
  // Stop button too and both transports drive the same lifecycle enum.
  it('drives the lifecycle enum on a send-only (HTTP) connection as well', async () => {
    const lifecycle: any[] = []
    const legacy: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendOnly: true, sendIntervalMs: 0 } as any,
      () =>
        fakeAppWith(
          async (a) => void legacy.push(a),
          async (method, a) => {
            if (method === 'agents.sessions.setStatus') lifecycle.push(a)
            return {}
          }
        ) as any
    )

    await conn.setStatus('C1', '123.45', 'is thinking…')
    await conn.setStatus('C1', '123.45', '')

    expect(legacy).toHaveLength(2)
    expect(lifecycle).toEqual([
      { channel_id: 'C1', thread_ts: '123.45', status: 'processing' },
      { channel_id: 'C1', thread_ts: '123.45', status: 'active' }
    ])
  })

  it('keeps a failing lifecycle call out of dispatch', async () => {
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        fakeAppWith(
          async () => undefined,
          async () => {
            throw new Error('not_an_agent_session')
          }
        ) as any
    )
    await expect(conn.setStatus('C1', '123.45', 'is thinking…')).resolves.toBeUndefined()
  })

  it('posts one permission-update card when Slack reports a missing scope', async () => {
    const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'assistant:write', provided: 'chat:write' }
    })
    const postMessage = vi.fn(async () => ({ ts: 'card-1' }))
    const conn = new SlackConnection(
      { ...deps(), group: { ...deps().group, appId: 'A123' }, sendIntervalMs: 0 } as any,
      () =>
        fakeAppWith(
          async () => {
            throw missingScope
          },
          undefined,
          postMessage
        ) as any
    )
    await conn.start()

    await conn.setStatus('C1', '123.45', 'is thinking…')
    await conn.setStatus('C1', '123.45', 'is still thinking…')

    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '123.45',
        text: expect.stringContaining('Permissions update required'),
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'actions',
            elements: [
              expect.objectContaining({
                style: 'primary',
                url: 'https://app.slack.com/app-settings/T123/A123/oauth'
              })
            ]
          })
        ]),
        metadata: { event_type: 'agentconnect_chrome', event_payload: {} }
      })
    )
  })
})

describe('SlackConnection agent_session_stopped', () => {
  // The native stop button. Slack leaves the session in `processing` after it fires, so the
  // app owes both halves: interrupt the running turn, then transition the session itself.
  const stopApp = (
    handlers: Map<string, (a: { event: unknown }) => unknown>,
    apiCall: (method: string, a: any) => Promise<unknown>
  ) => ({
    message() {},
    event(type: string, h: (a: { event: unknown }) => unknown) {
      handlers.set(type, h)
    },
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'UBOT' }) },
      views: { open: async () => {}, update: async () => {} },
      chat: { postMessage: async () => ({}), getPermalink: async () => ({ permalink: 'https://example.slack.com/t' }) },
      assistant: { threads: { setStatus: async () => undefined } },
      apiCall
    },
    start: async () => {},
    stop: async () => {}
  })

  const stopped = (over: Record<string, unknown> = {}) => ({
    event: {
      type: 'agent_session_stopped',
      channel: 'C1',
      thread_ts: '200.1',
      streaming_message_ts: [],
      user: 'U1',
      event_ts: '200.9',
      ...over
    }
  })

  const started = async (sessionKey: string | undefined) => {
    const handlers = new Map<string, (a: { event: unknown }) => unknown>()
    const lifecycle: any[] = []
    const actions: any[] = []
    const resolved: any[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        sendIntervalMs: 0,
        onMessageShortcut: async (a: unknown) => {
          resolved.push(a)
          return sessionKey
        },
        onStatusAction: (a: unknown) => void actions.push(a)
      } as any,
      () =>
        stopApp(handlers, async (method, a) => {
          if (method === 'agents.sessions.setStatus') lifecycle.push(a)
          return {}
        }) as any
    )
    await conn.start()
    return { conn, handlers, lifecycle, actions, resolved }
  }

  it('cancels the turn the stopped session owns and transitions the session itself', async () => {
    const { handlers, lifecycle, actions, resolved } = await started('slack:C1:200.1:bot-a')

    await handlers.get('agent_session_stopped')!(stopped())

    expect(resolved).toEqual([{ channel: 'C1', thread: '200.1', userId: 'U1' }])
    expect(actions).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:200.1:bot-a', actor: { userId: 'U1' } }])
    expect(lifecycle).toEqual([{ channel_id: 'C1', thread_ts: '200.1', status: 'active' }])
  })

  it('still transitions the session when no local session owns the thread', async () => {
    const { handlers, lifecycle, actions } = await started(undefined)

    await handlers.get('agent_session_stopped')!(stopped())

    expect(actions).toEqual([])
    expect(lifecycle).toEqual([{ channel_id: 'C1', thread_ts: '200.1', status: 'active' }])
  })

  it('makes the turn-end status clear that follows a stop a no-op', async () => {
    const { conn, handlers, lifecycle } = await started('slack:C1:200.1:bot-a')

    await handlers.get('agent_session_stopped')!(stopped())
    await conn.setStatus('C1', '200.1', '')

    expect(lifecycle).toEqual([{ channel_id: 'C1', thread_ts: '200.1', status: 'active' }])
  })

  it('ignores a payload without session coordinates', async () => {
    const { handlers, lifecycle, actions } = await started('slack:C1:200.1:bot-a')

    await handlers.get('agent_session_stopped')!(stopped({ thread_ts: undefined }))

    expect(actions).toEqual([])
    expect(lifecycle).toEqual([])
  })

  // The HTTP arm. A send-only connection registers no Bolt handler at all — the relay forwards
  // the event and the daemon calls the same method, so both transports share one implementation.
  it('runs the same resolve → cancel → transition when the relay forwards the stop', async () => {
    const handlers = new Map<string, (a: { event: unknown }) => unknown>()
    const lifecycle: any[] = []
    const actions: any[] = []
    const resolved: any[] = []
    const conn = new SlackConnection(
      {
        ...deps(),
        sendOnly: true,
        sendIntervalMs: 0,
        onMessageShortcut: async (a: unknown) => {
          resolved.push(a)
          return 'slack:C1:200.1:bot-a'
        },
        onStatusAction: (a: unknown) => void actions.push(a)
      } as any,
      () =>
        stopApp(handlers, async (method, a) => {
          if (method === 'agents.sessions.setStatus') lifecycle.push(a)
          return {}
        }) as any
    )
    await conn.start()
    expect(handlers.has('agent_session_stopped')).toBe(false)

    await conn.agentSessionStopped('C1', '200.1', 'U1')

    expect(resolved).toEqual([{ channel: 'C1', thread: '200.1', userId: 'U1' }])
    expect(actions).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:200.1:bot-a', actor: { userId: 'U1' } }])
    expect(lifecycle).toEqual([{ channel_id: 'C1', thread_ts: '200.1', status: 'active' }])
  })
})

describe('SlackConnection.setTitle', () => {
  it('maps args to agents.sessions.rename', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      deps() as any,
      () =>
        fakeAppWith(
          async () => undefined,
          async (method, a) => void calls.push([method, a])
        ) as any
    )
    await conn.setTitle('D1', '123.45', 'Runtime summary')
    expect(calls[0]).toEqual([
      'agents.sessions.rename',
      { channel_id: 'D1', thread_ts: '123.45', title: 'Runtime summary' }
    ])
  })

  it('swallows errors and never rejects (best-effort)', async () => {
    const conn = new SlackConnection(
      deps() as any,
      () =>
        fakeAppWith(
          async () => undefined,
          async () => {
            throw new Error('invalid_thread_ts')
          }
        ) as any
    )
    await expect(conn.setTitle('D1', '123.45', 'Runtime summary')).resolves.toBeUndefined()
  })

  it('coalesces concurrent missing-scope notices into one card', async () => {
    const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'assistant:write', provided: 'chat:write' }
    })
    let resolveCard!: (value: { ts: string }) => void
    const postMessage = vi.fn(
      () =>
        new Promise<{ ts: string }>((resolve) => {
          resolveCard = resolve
        })
    )
    const rename = vi.fn(async () => {
      throw missingScope
    })
    const conn = new SlackConnection(
      { ...deps(), group: { ...deps().group, appId: 'A123' }, sendIntervalMs: 0 } as any,
      () => fakeAppWith(async () => undefined, rename, postMessage) as any
    )

    const first = conn.setTitle('D1', '123.45', 'First title')
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce())
    const second = conn.setTitle('D1', '123.45', 'Second title')
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(2))
    expect(postMessage).toHaveBeenCalledOnce()

    resolveCard({ ts: 'card-1' })
    await Promise.all([first, second])
  })
})

describe('SlackConnection.updateBlocks', () => {
  const withUpdate = (update: (payload: any) => Promise<unknown>) => ({
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: { chat: { update } },
    start: async () => {},
    stop: async () => {}
  })

  it('can replace visible blocks without resending the original top-level text', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withUpdate(async (payload) => void calls.push(payload)) as any
    )
    const blocks = [
      { type: 'markdown', text: 'answer' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'sent by bot (runtime · model) · open in session' }] }
    ]

    await expect(conn.updateBlocks('C1', '123.45', blocks)).resolves.toBe(true)

    expect(calls).toEqual([
      {
        channel: 'C1',
        ts: '123.45',
        blocks,
        unfurl_links: false,
        unfurl_media: false
      }
    ])
  })

  it('re-stamps stable agent authorship when an agent reply is edited', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withUpdate(async (payload) => void calls.push(payload)) as any
    )
    const blocks = [{ type: 'markdown', text: 'updated answer' }]

    await expect(conn.updateBlocks('C1', '123.45', blocks, 'updated answer', false, 'agent-a')).resolves.toBe(true)

    expect(calls[0]).toMatchObject({
      metadata: {
        event_type: 'agentconnect_thread_event',
        event_payload: { author_agent_id: 'agent-a' }
      }
    })
  })

  it('re-stamps agent-scoped chrome ownership when a status bar is edited', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withUpdate(async (payload) => void calls.push(payload)) as any
    )
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'status' } }]

    await expect(conn.updateBlocks('C1', '123.45', blocks, 'status', true, undefined, 'agent-a')).resolves.toBe(true)

    expect(calls[0]).toMatchObject({
      metadata: {
        event_type: 'agentconnect_chrome',
        event_payload: { owner_agent_id: 'agent-a' }
      }
    })
  })

  it('returns false when the best-effort update fails so callers can retry cleanup', async () => {
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        withUpdate(async () => {
          throw new Error('ratelimited')
        }) as any
    )

    await expect(conn.updateBlocks('C1', '123.45', [{ type: 'markdown', text: 'answer' }])).resolves.toBe(false)
  })

  it('also normalizes an outer send-queue timeout rejection to false', async () => {
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withUpdate(async () => undefined) as any
    )
    ;(conn as any).queue = {
      enqueue: vi.fn(async () => {
        throw new Error('PlatformSendQueue: task exceeded 30000ms — abandoned')
      })
    }

    await expect(conn.updateBlocks('C1', '123.45', [{ type: 'markdown', text: 'answer' }])).resolves.toBe(false)
  })
})

describe('SlackConnection chat.postMessage boundary', () => {
  const withPostMessage = (
    postMessage: (payload: any) => Promise<{ ts?: string }>,
    getPermalink: (payload: any) => Promise<{ permalink?: string }> = async () => ({
      permalink: 'https://example.slack.com/thread'
    })
  ) => ({
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: { chat: { postMessage, getPermalink } },
    start: async () => {},
    stop: async () => {}
  })

  it('silently skips a reply when its thread root was deleted', async () => {
    const postMessage = vi.fn(async () => ({ ts: '100.2' }))
    const missingRoot = Object.assign(new Error('An API error occurred: message_not_found'), {
      data: { error: 'message_not_found' }
    })
    const getPermalink = vi.fn(async () => {
      throw missingRoot
    })
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withPostMessage(postMessage, getPermalink) as any
    )

    await expect(conn.postMessage('C1', 'body', '100.1')).resolves.toBeUndefined()
    expect(getPermalink).toHaveBeenCalledWith({ channel: 'C1', message_ts: '100.1' })
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('fails closed when root existence cannot be verified', async () => {
    const postMessage = vi.fn(async () => ({ ts: '100.2' }))
    const rateLimited = Object.assign(new Error('An API error occurred: ratelimited'), {
      data: { error: 'ratelimited' }
    })
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        withPostMessage(postMessage, async () => {
          throw rateLimited
        }) as any
    )

    await expect(conn.postMessage('C1', 'body', '100.1')).rejects.toBe(rateLimited)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('persists the stable agent author in Slack message metadata', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withPostMessage(async (payload) => (calls.push(payload), { ts: '100.2' })) as any
    )

    await conn.postMessage('C1', '@agent-a → @agent-b: review', '100.1', {
      username: 'Agent A',
      agentAuthorId: 'agent-a'
    })

    expect(calls[0]).toMatchObject({
      username: 'Agent A',
      metadata: {
        event_type: 'agentconnect_thread_event',
        event_payload: { author_agent_id: 'agent-a' }
      }
    })
  })

  it('posts linked trailing context with the reply and disables unfurls on the initial post', async () => {
    const calls: any[] = []
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () => withPostMessage(async (payload) => (calls.push(payload), { ts: `t${calls.length}` })) as any
    )
    const options = { username: 'deploy-bot' }
    const footer = [{ type: 'context', elements: [{ type: 'mrkdwn', text: '<https://app|open>' }] }]

    await conn.postMessage('C1', 'body', '100.1', { ...options, trailingBlocks: footer })
    await conn.postBlocks('C1', [{ type: 'section' }], 'fallback', '100.1', options)

    expect(calls).toHaveLength(2)
    expect(calls.map((payload) => payload.username)).toEqual([options.username, options.username])
    expect(calls[0]).toMatchObject({
      channel: 'C1',
      thread_ts: '100.1',
      text: 'body',
      blocks: [{ type: 'markdown', text: 'body' }, ...footer],
      unfurl_links: false,
      unfurl_media: false
    })
  })

  it('passes the agent icon_url through, and drops it with username on a missing customize scope', async () => {
    const calls: any[] = []
    const missingCustomize = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'chat:write.customize', provided: 'chat:write' }
    })
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        withPostMessage(async (payload) => {
          calls.push(payload)
          if (payload.icon_url) throw missingCustomize
          return { ts: `t${calls.length}` }
        }) as any
    )
    const footer = [{ type: 'context', elements: [{ type: 'mrkdwn', text: '<https://app|open>' }] }]
    const options = {
      username: 'deploy-bot',
      icon_url: 'https://cp/v1/agents/a1/icon?v=3',
      trailingBlocks: footer
    }

    // First send carries username + icon_url; on missing scope it retries with neither.
    await conn.postMessage('C1', 'body', '100.1', options)
    expect(calls[0]).toMatchObject({ username: options.username, icon_url: options.icon_url })
    expect(calls[1]).not.toHaveProperty('icon_url')
    expect(calls[1]).not.toHaveProperty('username')
    expect(calls[1]).toMatchObject({
      blocks: [{ type: 'markdown', text: 'body' }, ...footer],
      unfurl_links: false,
      unfurl_media: false
    })
  })

  it('retries without username, backs off, then re-probes chat:write.customize', async () => {
    const calls: any[] = []
    const missingCustomize = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'chat:write.customize', provided: 'chat:write' }
    })
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        withPostMessage(async (payload) => {
          calls.push(payload)
          if (payload.username) throw missingCustomize
          return { ts: `t${calls.length}` }
        }) as any
    )
    const options = { username: 'support-bot' }

    await expect(conn.postMessage('C1', 'first', '100.1', options)).resolves.toBe('t2')
    await expect(conn.postMessage('C1', 'second', '100.1', options)).resolves.toBe('t3')
    ;(conn as any).customUsernameRetryAt = 0
    await expect(conn.postMessage('C1', 'third', '100.1', options)).resolves.toBe('t5')

    expect(calls[0]).toMatchObject({ username: options.username })
    expect(calls[1]).not.toHaveProperty('username')
    expect(calls[2]).not.toHaveProperty('username')
    expect(calls[3]).toMatchObject({ username: options.username })
    expect(calls[4]).not.toHaveProperty('username')
  })

  it('does not retry an unrelated missing scope and risk a duplicate send', async () => {
    const calls: any[] = []
    const missingChatWrite = Object.assign(new Error('An API error occurred: missing_scope'), {
      data: { error: 'missing_scope', needed: 'chat:write', provided: '' }
    })
    const conn = new SlackConnection(
      { ...deps(), sendIntervalMs: 0 } as any,
      () =>
        withPostMessage(async (payload) => {
          calls.push(payload)
          throw missingChatWrite
        }) as any
    )

    await expect(conn.postMessage('C1', 'body', '100.1', { username: 'support-bot' })).rejects.toBe(missingChatWrite)
    expect(calls).toHaveLength(1)
  })
})
