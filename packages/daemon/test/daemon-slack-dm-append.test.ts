import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { SlackAppFactory } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'

// assistant-mode.md §5.2: a Slack DM on `append` keys every message onto one session, and each answer
// still lands in the physical thread its question came from. Driven from raw Slack events, so the
// normalizer, the Assistant-thread memory and the real dispatch path are all in the loop.

type Handler = (args: { event?: unknown; message?: unknown }) => Promise<void>

function scaffold(mode: 'createNew' | 'append'): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-slack-dm-append-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'dm' } }],
            ...(mode === 'append' ? { sessionModes: [{ channel: 'D1', mode: 'append' }] } : {})
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(mode: 'createNew' | 'append') {
  const handlers = new Map<string, Handler>()
  const base = fakeSlackAppFactory()
  const factory: SlackAppFactory = (opts) => {
    const app = base(opts) as unknown as Record<string, unknown>
    app.message = (fn: Handler) => handlers.set('message', fn)
    app.event = (type: string, fn: Handler) => handlers.set(type, fn)
    return app as unknown as ReturnType<SlackAppFactory>
  }
  let onUpdate!: (sid: string, update: unknown) => void
  let turns = 0
  const newSession = vi.fn(async () => `acp-${newSession.mock.calls.length}`)
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession,
    hasSession: () => true,
    prompt: vi.fn(async (sid: string) => {
      turns++
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answer ${turns}` } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(mode),
    slackAppFactory: factory,
    hostFactory: (_agent, update) => {
      onUpdate = update
      return host as never
    }
  })
  await daemon.start()
  const posts: { channel: string; text: string; thread?: string }[] = []
  vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue({
    setStatus: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
      posts.push({ channel, text, thread })
      return `reply-${posts.length}`
    }),
    updateMessage: vi.fn(async () => {}),
    postBlocks: vi.fn(async () => 'status-ts'),
    updateBlocks: vi.fn(async () => {}),
    postContext: vi.fn(async () => {})
  })
  const store = (daemon as never as { store: any }).store
  const scope = (
    daemon as never as { transportScopeForIntegrationIds: (ids: string[]) => string | undefined }
  ).transportScopeForIntegrationIds(['int-bot-a'])
  const sessionThreads = async (): Promise<string[]> =>
    ((await store.db.prepare("SELECT thread FROM sessions WHERE channel = 'D1'").all()) as { thread: string }[]).map(
      (row) => row.thread
    )
  const dm = async (ts: string, text: string, threadTs?: string) =>
    await handlers.get('message')!({
      message: {
        type: 'message',
        channel: 'D1',
        channel_type: 'im',
        user: 'U1',
        text,
        ts,
        ...(threadTs ? { thread_ts: threadTs } : {})
      }
    })
  const answers = () => posts.filter((p) => p.text.startsWith('answer '))
  return { daemon, handlers, host, posts, answers, dm, store, scope, sessionThreads }
}

// A new chat opens after the conversation's current coordinate was minted, as it does live.
const threadRootAfterNow = (): string => `${Math.floor(Date.now() / 1000) + 5}.000500`

describe('a Slack DM on append', () => {
  it('keys top-level and in-thread messages onto one session and answers in each physical thread', async () => {
    const { daemon, host, answers, dm, sessionThreads } = await boot('append')

    await dm('1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    await dm('1720000000.000200', 'second')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    await dm('1720000000.000300', 'a reply under the first', '1720000000.000100')
    await vi.waitFor(() => expect(answers()).toHaveLength(3))

    // One runtime session, under one append coordinate.
    expect(host.newSession).toHaveBeenCalledTimes(1)
    const threads = await sessionThreads()
    expect(threads).toHaveLength(1)
    expect(isAppendCoordinate(threads[0])).toBe(true)
    // Each answer lands in the thread its question was asked in.
    expect(answers().map((p) => [p.channel, p.thread])).toEqual([
      ['D1', '1720000000.000100'],
      ['D1', '1720000000.000200'],
      ['D1', '1720000000.000100']
    ])
    await daemon.stop()
  })

  it('starts a fresh session on `!new`', async () => {
    const { daemon, host, answers, dm, store, scope } = await boot('append')
    await dm('1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    const before = await store.currentAppendCoordinate('bot-a', 'D1', scope)

    await dm('1720000000.000200', '!new')
    await vi.waitFor(async () => expect(await store.currentAppendCoordinate('bot-a', 'D1', scope)).not.toBe(before))
    expect(isAppendCoordinate(await store.currentAppendCoordinate('bot-a', 'D1', scope))).toBe(true)

    await dm('1720000000.000300', 'next')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(host.newSession).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  // Slack's Assistant "new chat" is the platform's own `!new`.
  it('starts a fresh session when a new Assistant thread opens, and answers inside it', async () => {
    const { daemon, handlers, host, answers, dm, store, scope } = await boot('append')
    await dm('1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    const before = await store.currentAppendCoordinate('bot-a', 'D1', scope)
    const root = threadRootAfterNow()

    await handlers.get('assistant_thread_started')!({
      event: { assistant_thread: { user_id: 'U1', channel_id: 'D1', thread_ts: root } }
    })
    const after = await store.currentAppendCoordinate('bot-a', 'D1', scope)
    expect(after).not.toBe(before)

    // A message in the new thread may arrive without thread_ts; it still answers inside that thread.
    await dm('1720000000.000600', 'in the new chat')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(answers()[1]!.thread).toBe(root)
    expect(host.newSession).toHaveBeenCalledTimes(2)
    expect(await store.currentAppendCoordinate('bot-a', 'D1', scope)).toBe(after)
    await daemon.stop()
  })

  // Socket Mode redelivers an event it did not see acknowledged; the redelivery must not split the new chat.
  it('rotates once for a redelivered Assistant thread event', async () => {
    const { daemon, handlers, host, answers, dm, store, scope } = await boot('append')
    await dm('1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    const started = {
      event: { assistant_thread: { user_id: 'U1', channel_id: 'D1', thread_ts: threadRootAfterNow() } }
    }

    await handlers.get('assistant_thread_started')!(started)
    const rotated = await store.currentAppendCoordinate('bot-a', 'D1', scope)
    await dm('1720000000.000600', 'in the new chat')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))

    await handlers.get('assistant_thread_started')!(started)
    expect(await store.currentAppendCoordinate('bot-a', 'D1', scope)).toBe(rotated)
    await dm('1720000000.000700', 'still the same chat')
    await vi.waitFor(() => expect(answers()).toHaveLength(3))
    expect(host.newSession).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })

  it('mints nothing when a new Assistant thread opens before anyone spoke', async () => {
    const { daemon, handlers, store, scope } = await boot('append')
    await handlers.get('assistant_thread_started')!({
      event: { assistant_thread: { user_id: 'U1', channel_id: 'D1', thread_ts: '1720000000.000500' } }
    })
    expect(await store.currentAppendCoordinate('bot-a', 'D1', scope)).toBeUndefined()
    await daemon.stop()
  })
})

// The HTTP arm: the relay forwards the event as a platform action to the DM owner's daemon.
describe('a relay-forwarded new Assistant thread', () => {
  it('rotates the DM owner onto a fresh session where the DM appends', async () => {
    const { daemon } = await boot('append')
    const inner = daemon as never as {
      agents: Map<string, { integrations: { core: { mode?: string } }[] }>
      connByIntegration: Map<string, unknown>
      store: any
      transportScopeForIntegrationIds: (ids: string[]) => string | undefined
      handleRelayMsg: (msg: unknown, reply: () => void) => Promise<unknown>
    }
    inner.agents.get('bot-a')!.integrations[0]!.core.mode = 'shared'
    inner.connByIntegration.set('int-bot-a', {})
    const scope = inner.transportScopeForIntegrationIds(['int-bot-a'])
    const before = await inner.store.resolveAppendCoordinate('bot-a', 'D1', scope, 1)

    const ack = await inner.handleRelayMsg(
      {
        source: 'platform_action',
        platformId: 'slack',
        agentId: 'bot-a',
        integrationId: 'int-bot-a',
        sessionKey: 'D1',
        msgId: 'slack-action:new-chat',
        botId: 'shared-bot',
        userId: 'U1',
        payload: { kind: 'assistant-thread-started', channelId: 'D1', threadTs: '1720000000.000500' }
      },
      () => {}
    )

    expect(ack).toEqual({ msgId: 'slack-action:new-chat', accepted: true })
    const after = await inner.store.currentAppendCoordinate('bot-a', 'D1', scope)
    expect(isAppendCoordinate(after)).toBe(true)
    expect(after).not.toBe(before)

    // A redelivered action names the same thread root and leaves the new chat's coordinate alone.
    await inner.handleRelayMsg(
      {
        source: 'platform_action',
        platformId: 'slack',
        agentId: 'bot-a',
        integrationId: 'int-bot-a',
        sessionKey: 'D1',
        msgId: 'slack-action:new-chat-retry',
        botId: 'shared-bot',
        userId: 'U1',
        payload: { kind: 'assistant-thread-started', channelId: 'D1', threadTs: '1720000000.000500' }
      },
      () => {}
    )
    expect(await inner.store.currentAppendCoordinate('bot-a', 'D1', scope)).toBe(after)
    await daemon.stop()
  })
})

describe('a Slack DM on createNew', () => {
  it('keeps a session per top-level message, and a new Assistant thread touches no reservation', async () => {
    const { daemon, handlers, host, answers, dm, store, scope, sessionThreads } = await boot('createNew')
    await dm('1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    await dm('1720000000.000200', 'second')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(host.newSession).toHaveBeenCalledTimes(2)
    expect((await sessionThreads()).sort()).toEqual(['1720000000.000100', '1720000000.000200'])

    await handlers.get('assistant_thread_started')!({
      event: { assistant_thread: { user_id: 'U1', channel_id: 'D1', thread_ts: '1720000000.000500' } }
    })
    expect(await store.currentAppendCoordinate('bot-a', 'D1', scope)).toBeUndefined()
    await daemon.stop()
  })
})
