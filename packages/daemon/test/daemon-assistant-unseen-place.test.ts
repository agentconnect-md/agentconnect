import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { SlackAppFactory } from '../src/slack/connection.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'

// assistant-mode.md §5.2, #2979 B7: an assistant-mode place keeps one session from its first message, before the
// control plane has listed the conversation; a conversation it lists keeps that mode, and other agents are unchanged.

type Handler = (args: { event?: unknown; message?: unknown }) => Promise<void>

function scaffold(opts: { assistantMode: boolean; sessionModes?: { channel: string; mode: string }[] }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-assistant-unseen-'))
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
      ...(opts.assistantMode ? { assistantMode: { enabled: true } } : {}),
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          // DMs open by default; the room answers every message so only its session keying is under test. Nothing is listed.
          core: {
            bindRules: [{ match: { kind: 'dm' } }, { match: { kind: 'auto' }, channel: 'C1' }],
            ...(opts.sessionModes ? { sessionModes: opts.sessionModes } : {})
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(opts: { assistantMode: boolean; sessionModes?: { channel: string; mode: string }[] }) {
  const handlers = new Map<string, Handler>()
  const base = fakeSlackAppFactory()
  const factory: SlackAppFactory = (factoryOpts) => {
    const app = base(factoryOpts) as unknown as Record<string, unknown>
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
    root: scaffold(opts),
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
  const sessionThreads = async (channel: string): Promise<string[]> =>
    (
      (await store.db.prepare('SELECT thread FROM sessions WHERE channel = ?').all(channel)) as { thread: string }[]
    ).map((row) => row.thread)
  const send = async (channel: string, channelType: 'im' | 'channel', ts: string, text: string) =>
    await handlers.get('message')!({
      message: { type: 'message', channel, channel_type: channelType, user: 'U1', text, ts }
    })
  const answers = () => posts.filter((p) => p.text.startsWith('answer '))
  return { daemon, host, answers, send, sessionThreads }
}

/** Two top-level room messages through the real ingress ladder, dispatch stubbed: the session coordinate each resolved. */
async function roomCoordinates(daemon: Daemon): Promise<(string | undefined)[]> {
  const seen: (string | undefined)[] = []
  ;(daemon as never as { dispatch: unknown }).dispatch = vi.fn(
    async (_agentId: string, msg: { sessionThread?: string }) => {
      seen.push(msg.sessionThread)
    }
  )
  for (const ts of ['1720000000.000100', '1720000000.000200'])
    await (daemon as never as { onInboundOutcome: (m: unknown, s: string[]) => Promise<unknown> }).onInboundOutcome(
      {
        msgId: `slack:C1:${ts}`,
        traceId: 't',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        ts,
        sender: { id: 'U1', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm: false
      },
      ['int-bot-a']
    )
  expect(seen).toHaveLength(2)
  return seen
}

describe('an Everyone assistant-mode agent in a conversation the control plane has not listed', () => {
  it('keys the first two DMs onto one append session', async () => {
    const { daemon, host, answers, send, sessionThreads } = await boot({ assistantMode: true })
    await send('D1', 'im', '1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    await send('D1', 'im', '1720000000.000200', 'second')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(host.newSession).toHaveBeenCalledTimes(1)
    const threads = await sessionThreads('D1')
    expect(threads).toHaveLength(1)
    expect(isAppendCoordinate(threads[0])).toBe(true)
    await daemon.stop()
  })

  it('keys the first two messages in a room onto one append session', async () => {
    const { daemon } = await boot({ assistantMode: true })
    const coordinates = await roomCoordinates(daemon)
    expect(coordinates.every(isAppendCoordinate)).toBe(true)
    expect(new Set(coordinates).size).toBe(1)
    await daemon.stop()
  })

  // The control plane lists a By decision room, or a group DM, on its own mode; the default never overrides it.
  it('keeps a session per thread where the control plane lists the conversation on its own mode', async () => {
    const { daemon } = await boot({ assistantMode: true, sessionModes: [{ channel: 'C1', mode: 'createNew' }] })
    expect(await roomCoordinates(daemon)).toEqual([undefined, undefined])
    await daemon.stop()
  })
})

describe('an agent outside assistant mode in a conversation the control plane has not listed', () => {
  it('keeps a session per top-level DM', async () => {
    const { daemon, host, answers, send, sessionThreads } = await boot({ assistantMode: false })
    await send('D1', 'im', '1720000000.000100', 'first')
    await vi.waitFor(() => expect(answers()).toHaveLength(1))
    await send('D1', 'im', '1720000000.000200', 'second')
    await vi.waitFor(() => expect(answers()).toHaveLength(2))
    expect(host.newSession).toHaveBeenCalledTimes(2)
    expect((await sessionThreads('D1')).sort()).toEqual(['1720000000.000100', '1720000000.000200'])
    await daemon.stop()
  })
})
