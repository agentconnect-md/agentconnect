// auto-session-mode.md §6.8: a coordinator's task works in its message's thread and holds a Slack code channel only once it makes one.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { coordinatorSessionTools, renderCoordinatorBatch } from '../src/auto-session/coordinator-prompt.js'
import {
  CoordinatorSessions,
  deliveredMessage,
  TASK_ROOM_ATTACH_WAIT_MS
} from '../src/auto-session/coordinator-sessions.js'
import { wholeRoomThread } from '../src/auto-session/coordinator-turns.js'
import { roomRunReport } from '../src/collab/coordinator.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { executeTool } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { coordinatorCoordinate } from '../src/session/append-coordinate.js'
import { buildStandingContext, THREADED_TASK_APPEND } from '../src/session/turn/standing-context.js'
import { sessionKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'
import { WAIT } from './wait-support.js'

const slack = (ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:C1:${ts}`,
    traceId: `t-${ts}`,
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

const LINK = 'https://workspace.example.test/archives/C2'
const ROOM = { platform: 'slack', channel: 'C2', thread: 'C2', transportScope: null }

describe('a coordinator task and the channel it makes', () => {
  const COORDINATOR = coordinatorCoordinate(1)
  const coordinatorKey = sessionKey('slack', 'C1', COORDINATOR, 'bot-a')
  const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a')

  async function setup() {
    const store = await openTestStore()
    const dispatched: NormalizedMessage[] = []
    const posted: { thread?: string; text: string }[] = []
    const warnings: string[] = []
    const sessions = new CoordinatorSessions({
      store: () => store,
      now: () => 1_000,
      dispatch: (_agentId, msg) => void dispatched.push(msg),
      post: async (_agentId, _integrationId, msg, text) => void posted.push({ thread: msg.thread, text }),
      showTriaging: () => () => {},
      sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
      reportTaskOwners: async () => {},
      threadLink: (_integrationId, at) => `https://workspace.example.test/archives/${at.channel}`,
      warn: (message) => void warnings.push(message)
    })
    const ctx: SessionContext = {
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: COORDINATOR,
      deliveryThread: '1.1',
      isDm: false,
      tools: coordinatorSessionTools([])
    }
    const begin = (...msgs: NormalizedMessage[]) =>
      sessions.turns.begin(
        coordinatorKey,
        msgs.map((msg) => deliveredMessage({ ...msg, sessionThread: COORDINATOR, headless: true }, 'int-bot-a'))
      )
    const delegate = async () => {
      begin(slack('1.1', { text: 'fix the flaky test' }))
      return await sessions.decide(ctx, {
        action: 'delegateTask',
        messageId: 'msg-1.1',
        title: 'Flaky test',
        message: 'it fails on main only'
      })
    }
    return { store, sessions, ctx, begin, delegate, dispatched, posted, warnings }
  }

  it('opens a delegated message’s task in its thread and asks for no channel', async () => {
    const { store, delegate, dispatched, posted } = await setup()
    expect(await delegate()).toMatchObject({
      ok: true,
      taskId: taskKey,
      note: "Task opened; it answers in the message's thread."
    })
    expect(await store.assistantSubsessions.threadsOf('bot-a', taskKey)).toEqual([
      expect.objectContaining({ channel: 'C1', thread: '1.1' })
    ])
    expect(dispatched.map((msg) => [msg.channel, msg.thread])).toEqual([['C1', '1.1']])
    expect(dispatched[0]!.turnBody?.prompt).toContain('it fails on main only')
    // The coordinator links nothing: the task answers in the thread itself.
    expect(posted).toEqual([])
  })

  it('lets a task hold the channel it makes as one more thread, its origin thread still attached', async () => {
    const { store, sessions, delegate } = await setup()
    await delegate()
    const result = await sessions.makeRoom('bot-a', taskKey, async () => ({ result: 'made', room: ROOM }))
    expect(result).toBe('made')
    const index = store.assistantSubsessions
    expect(await index.threadsOf('bot-a', taskKey)).toEqual([
      expect.objectContaining({ channel: 'C1', thread: '1.1' }),
      expect.objectContaining({ channel: 'C2', thread: 'C2' })
    ])
    expect(await index.taskOfThread('bot-a', ROOM)).toBe(taskKey)
    expect(await index.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '1.1' })).toBe(taskKey)
  })

  it('leaves the channel a session that is no task makes to the channel’s own session', async () => {
    const { store, sessions } = await setup()
    const ordinary = sessionKey('slack', 'C9', '9.1', 'bot-a')
    expect(await sessions.makeRoom('bot-a', ordinary, async () => ({ result: 'made', room: ROOM }))).toBe('made')
    // A thread session adopted on a switch into auto was opened for no message, and holds none either (§3.5).
    const adopted = sessionKey('slack', 'C1', '5.1', 'bot-a')
    await store.assistantSubsessions.adoptThreadSession({
      agentId: 'bot-a',
      childSessionKey: adopted,
      parentSessionId: 'coordinator-id',
      parentSessionKey: coordinatorKey,
      title: 'Earlier thread',
      platform: 'slack',
      channel: 'C1',
      transportScope: null,
      thread: '5.1',
      running: false,
      now: 1_000
    })
    await sessions.makeRoom('bot-a', adopted, async () => ({ result: 'made', room: ROOM }))
    expect(await store.assistantSubsessions.taskOfThread('bot-a', ROOM)).toBeUndefined()
  })

  it('holds a message in a room keyed as one thread until the room being made is attached, at most 30 seconds', async () => {
    const { store, sessions, delegate } = await setup()
    await delegate()
    let made!: () => void
    const making = sessions.makeRoom('bot-a', taskKey, async () => {
      await new Promise<void>((resolve) => (made = resolve))
      return { result: 'made', room: ROOM }
    })
    await vi.waitFor(() => expect(made).toBeDefined())
    let held: string | undefined
    const waiting = sessions.roomsAttached('bot-a').then(async () => {
      held = await store.assistantSubsessions.taskOfThread('bot-a', ROOM)
    })
    // Another agent's message does not wait for it.
    await sessions.roomsAttached('bot-b')
    expect(held).toBeUndefined()
    made()
    await waiting
    await making
    expect(held).toBe(taskKey)

    let started!: () => void
    const making2 = new Promise<void>((resolve) => (started = resolve))
    void sessions.makeRoom('bot-a', taskKey, () => {
      started()
      return new Promise(() => {})
    })
    await making2
    vi.useFakeTimers()
    try {
      let waited = false
      const stuck = sessions.roomsAttached('bot-a').then(() => (waited = true))
      await vi.advanceTimersByTimeAsync(TASK_ROOM_ATTACH_WAIT_MS - 1)
      expect(waited).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await stuck
      expect(waited).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves a message it hands a task into the channel the task holds, keyed on the task’s session', async () => {
    const { store, sessions, ctx, begin, delegate, dispatched, posted } = await setup()
    await delegate()
    await sessions.makeRoom('bot-a', taskKey, async () => ({ result: 'made', room: ROOM }))
    begin(slack('3.2', { thread: '3.1', text: 'is it fixed on main too?', replyThread: '3.1' }))
    const receipt = await sessions.decide(ctx, {
      action: 'messageTask',
      messageId: 'msg-3.2',
      taskId: taskKey,
      message: 'they asked in another thread'
    })
    expect(receipt).toMatchObject({ ok: true, taskId: taskKey, note: expect.stringContaining('moved') })
    const moved = dispatched.at(-1)!
    expect(moved).toMatchObject({
      msgId: 'slack:C1:3.2',
      channel: 'C2',
      thread: 'C2',
      sessionChannel: 'C1',
      sessionThread: '1.1',
      isDm: false
    })
    expect(moved.replyThread).toBeUndefined()
    expect(moved.turnBody?.prompt).toContain('they asked in another thread')
    expect(posted.at(-1)).toEqual({ thread: '3.1', text: `Passed to [Flaky test](${LINK})` })
    expect(
      await store.assistantSubsessions.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '3.1' })
    ).toBeUndefined()
  })

  it('opens a fallback task for a mention in its thread (§4.5)', async () => {
    const { begin, sessions, dispatched } = await setup()
    begin(slack('1.1', { trigger: 'mention', text: '<@UBOT> thoughts?' }))
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'failed')
    expect(dispatched.map((msg) => [msg.channel, msg.thread])).toEqual([['C1', '1.1']])
  })

  it('tells a threaded task that its runs in a channel it makes are reported, and renders that report', () => {
    const standing = buildStandingContext({
      agentName: 'bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '1.1',
      envSecretNames: [],
      fileSecrets: [],
      memoryIndex: '',
      usesMeta: false,
      threadedTask: true
    }).sessionContext
    expect(standing).toContain(THREADED_TASK_APPEND)
    expect(THREADED_TASK_APPEND).toContain('at the end of each run there the coordinator gets your summary')
    const report = roomRunReport('completed', 'Flaky test', 'Done: PR #12 is open.', LINK)
    expect(report.text).toBe(
      `[task run] Task "Flaky test" ended a run in its channel (${LINK}). Its summary: Done: PR #12 is open.`
    )
    expect(roomRunReport('failed', 'Flaky test', undefined, undefined).text).toBe(
      '[task run] Task "Flaky test" stopped in its channel before finishing (error). It has not written a summary yet.'
    )
    const batch = renderCoordinatorBatch(
      [
        {
          id: 'msg-9.9',
          from: 'U_FAKE_BOT',
          mentionsYou: false,
          report: true,
          task: taskKey,
          kind: 'delegated task',
          title: 'Flaky test',
          text: report.text
        }
      ],
      { channelId: 'C1' }
    )
    expect(batch).toContain(`<report id="msg-9.9" task="${taskKey}" kind="delegated task" title="Flaky test">`)
  })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-task-channel-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { autoSessionMode: true },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
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
            bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [
              { channel: 'C1', mode: 'auto' },
              { channel: 'C2', mode: 'auto' }
            ]
          },
          config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

describe('a coordinator task that makes its own code channel, through the daemon (auto-session-mode.md §6.8)', () => {
  async function boot() {
    const live: {
      d?: any
      ctx?: SessionContext
      task?: SessionContext
      makeChannel?: boolean
      replyToReport?: string
    } = {}
    const coordinatorTurns: string[] = []
    const taskTurns: { sessionId: string; text: string }[] = []
    const toolResults: unknown[] = []
    let sessions = 0
    let onUpdate: (sessionId: string, update: unknown) => void = () => {}
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      prompt: vi.fn(async (sessionId: string, blocks: { type: string; text?: string }[]) => {
        const prompt = blocks.map((block) => block.text ?? '').join('\n')
        const ids = [...prompt.matchAll(/<message id="(msg-[^"]+)"/g)].map((match) => match[1]!)
        const reports = [...prompt.matchAll(/<report id="([^"]+)"/g)].map((match) => match[1]!)
        if (ids.length === 0 && reports.length === 0) {
          taskTurns.push({ sessionId, text: prompt })
          // The task decides its work wants a channel, in its first run only.
          if (live.makeChannel) {
            live.makeChannel = false
            toolResults.push(
              await executeTool(live.task!, 'createSlackCodeChannel', { name: 'flaky-test' }, live.d.mcp.deps).catch(
                (err: unknown) => err
              )
            )
          }
          onUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'on it' } })
          return { stopReason: 'end_turn' }
        }
        coordinatorTurns.push(prompt)
        for (const id of ids)
          await live.d.coordinators.decide(live.ctx, {
            action: 'delegateTask',
            messageId: id,
            title: 'Flaky test',
            message: 'it fails on main only'
          })
        for (const id of reports)
          if (live.replyToReport)
            await live.d.coordinators.decide(live.ctx, {
              action: 'replyToMessage',
              messageId: id,
              message: live.replyToReport
            })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn()
    }
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as never
      },
      slackAppFactory: fakeSlackAppFactory()
    })
    await daemon.start()
    const d = daemon as any
    live.d = d
    // The harness has no real platform audience to bind a session to.
    d.bindSessionSource = async () => 'unchanged'
    vi.spyOn(d.placeMembers, 'isFullMember').mockResolvedValue(true)
    // The Slack connection the code channel tool acts through: C2 is the code channel Slack makes, C1 is not one.
    let creating: Promise<void> = Promise.resolve()
    const create = vi.fn(async (_args: unknown) => {
      await creating
      return { ok: true, channel_id: 'C2' }
    })
    vi.spyOn(d, 'anyConnForIntegration').mockReturnValue({
      botUserId: 'U_FAKE_BOT',
      codeChannel: async (channel: string) => ({ code: channel === 'C2', owners: ['U_FAKE_BOT'] }),
      codeChannelApi: async (method: string, args: unknown) => (method === 'create' ? await create(args) : {})
    })
    const taskPosts: { channel: string; thread?: string; text: string }[] = []
    vi.spyOn(d, 'replyConnFor').mockReturnValue({
      setStatus: vi.fn(async () => true),
      setTitle: vi.fn(async () => {}),
      getThreadReplies: vi.fn(async () => []),
      postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
        taskPosts.push({ channel, thread, text })
        return `1700000100.00000${taskPosts.length}`
      }),
      postBlocks: vi.fn(async () => '1700000200.000001'),
      updateMessage: vi.fn(async () => true),
      updateBlocks: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
      postContext: vi.fn(async () => {}),
      updateCodeContext: vi.fn(async () => true)
    })
    const coordinatorPosts: { channel: string; thread?: string; text: string }[] = []
    vi.spyOn(d, 'gatewayForIntegration').mockReturnValue({
      postMessage: vi.fn(async (channel: string, text: string, thread?: string) => {
        coordinatorPosts.push({ channel, thread, text })
      })
    })
    const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
    const coordinator: string = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
    live.ctx = {
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: coordinator,
      transportScope: scope,
      isDm: false,
      tools: coordinatorSessionTools([])
    } as SessionContext
    // The task's own bridge context: its session is the message's thread in C1.
    live.task = {
      agentId: 'bot-a',
      platform: 'slack',
      integrationId: 'int-bot-a',
      channel: 'C1',
      thread: '1.1',
      deliveryThread: '1.1',
      transportScope: scope,
      isDm: false,
      tools: []
    } as SessionContext
    const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
    const idle = async () => await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a', scope)
    const channelKey = sessionKey('slack', 'C2', 'C2', 'bot-a', scope)
    // Opens the task for a request, which makes its channel in its first run.
    const delegate = async () => {
      live.makeChannel = true
      await route(slack('1.1', { text: 'fix the flaky test, with a PR' }))
      await vi.waitFor(() => expect(taskTurns).toHaveLength(1), WAIT)
      await idle()
    }
    return {
      daemon,
      d,
      live,
      scope,
      taskKey,
      channelKey,
      route,
      idle,
      delegate,
      create,
      hold: (until: Promise<void>) => void (creating = until),
      coordinatorTurns,
      taskTurns,
      taskPosts,
      coordinatorPosts,
      toolResults
    }
  }

  // Slack's copy of the request, or a later message, in the code channel, as its code channel discovery canonicalizes it.
  const inChannel = (ts: string, text: string) =>
    slack(ts, { msgId: `slack:C2:${ts}`, channel: 'C2', thread: 'C2', text, conversationBotId: 'U_FAKE_BOT' })

  it('holds the channel its task makes, so the copy and later messages there reach the task’s session and answer there', async () => {
    const booted = await boot()
    const { d, taskKey, channelKey } = booted
    await booted.delegate()
    expect(booted.toolResults).toEqual([expect.objectContaining({ channel_id: 'C2' })])
    expect(booted.create).toHaveBeenCalledWith(
      expect.objectContaining({ origin_channel_id: 'C1', origin_message_ts: '1.1' })
    )
    // The task answered in its thread, and the coordinator posted nothing there.
    expect(booted.taskPosts).toEqual([{ channel: 'C1', thread: '1.1', text: 'on it' }])
    expect(booted.coordinatorPosts).toEqual([])
    const index = d.store.assistantSubsessions
    expect(await index.threadsOf('bot-a', taskKey)).toEqual([
      expect.objectContaining({ channel: 'C1', thread: '1.1' }),
      expect.objectContaining({ channel: 'C2', thread: 'C2' })
    ])

    await booted.route(inChannel('1.5', 'fix the flaky test, with a PR'))
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(2), WAIT)
    await booted.idle()
    // One session, the task's, answering in the channel; the channel has no session of its own.
    expect(booted.taskTurns[1]!.sessionId).toBe(booted.taskTurns[0]!.sessionId)
    expect(await d.store.getSession(channelKey)).toBeUndefined()
    expect(booted.taskPosts.at(-1)).toEqual({ channel: 'C2', thread: 'C2', text: 'on it' })
    // The channel is no conversation of its own to coordinate.
    expect(await d.store.currentAppendCoordinate('bot-a', 'C2', booted.scope, 'coordinator')).toBeUndefined()

    await booted.route(inChannel('1.6', 'and add a test'))
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(3), WAIT)
    await booted.idle()
    expect(booted.taskTurns[2]!.sessionId).toBe(booted.taskTurns[0]!.sessionId)
    // The origin thread still reaches the task's session, keyed in place.
    const calls: NormalizedMessage[] = []
    d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    await booted.route(slack('1.7', { thread: '1.1', text: 'how is it going?' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ channel: 'C1', thread: '1.1' })
    expect(calls[0]!.sessionThread).toBeUndefined()
    expect(calls[0]!.sessionChannel).toBeUndefined()
    await booted.daemon.stop()
  })

  it('holds Slack’s copy that arrives while the channel is still being attached, then hands it to the task', async () => {
    const booted = await boot()
    let created!: () => void
    booted.hold(new Promise<void>((resolve) => (created = resolve)))
    booted.live.makeChannel = true
    await booted.route(slack('1.1', { text: 'fix the flaky test, with a PR' }))
    await vi.waitFor(() => expect(booted.create).toHaveBeenCalled(), WAIT)
    // Slack delivers its copy before answering the creation.
    const copy = booted.route(inChannel('1.5', 'fix the flaky test, with a PR'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(booted.taskTurns).toHaveLength(1)
    created()
    await copy
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(2), WAIT)
    await booted.idle()
    expect(booted.taskTurns[1]!.sessionId).toBe(booted.taskTurns[0]!.sessionId)
    expect(await booted.d.store.getSession(booted.channelKey)).toBeUndefined()
    await booted.daemon.stop()
  })

  it('reports each run in its channel to the coordinator, which relays it in the origin thread', async () => {
    const booted = await boot()
    const { d, taskKey } = booted
    await booted.delegate()
    // A run answering in the asker's own thread reports nothing.
    expect(booted.coordinatorTurns).toHaveLength(1)
    await d.store.assistantSubsessions.setSummary('bot-a', taskKey, {
      summary: 'Done: PR #12 is open and green.',
      now: 2_000
    })
    booted.live.replyToReport = 'The flaky test is fixed in PR #12.'
    await booted.route(inChannel('1.5', 'fix the flaky test, with a PR'))
    await vi.waitFor(() => expect(booted.coordinatorTurns).toHaveLength(2), WAIT)
    await booted.idle()
    const reported = booted.coordinatorTurns[1]!
    expect(reported).toContain(`kind="delegated task" title="Flaky test">`)
    expect(reported).toMatch(/<report id="[^"]+" task="[^"]+"/)
    expect(reported).toContain('[task run] Task "Flaky test" ended a run in its channel')
    expect(reported).toContain('Its summary: Done: PR #12 is open and green.')
    expect(booted.coordinatorPosts).toEqual([
      { channel: 'C1', thread: '1.1', text: 'The flaky test is fixed in PR #12.' }
    ])
    await booted.daemon.stop()
  })

  it('keys a code channel no task holds on its one session, never on a coordinator of its own', async () => {
    const booted = await boot()
    const calls: NormalizedMessage[] = []
    booted.d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    await booted.route(inChannel('1.5', 'fix the flaky test'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ channel: 'C2', thread: 'C2' })
    expect(calls[0]!.sessionThread).toBeUndefined()
    expect(calls[0]!.sessionChannel).toBeUndefined()
    expect(await booted.d.store.currentAppendCoordinate('bot-a', 'C2', booted.scope, 'coordinator')).toBeUndefined()
    // A DM keyed as one thread is no room: it still has its coordinator where it runs auto.
    expect(wholeRoomThread({ channel: 'D1', thread: 'D1', isDm: true })).toBe(false)
    expect(wholeRoomThread({ channel: 'C2', thread: 'C2', isDm: false })).toBe(true)
    expect(wholeRoomThread({ channel: 'C1', thread: '1.1', isDm: false })).toBe(false)
    await booted.daemon.stop()
  })

  it('treats the channel a task holds as no place: a join takes nothing, and a follow-up there is the task’s place’s', async () => {
    const booted = await boot()
    const { d, taskKey, scope } = booted
    await booted.delegate()
    // The bot's join to the channel it made takes no getting-to-know task and no introduction.
    expect(await d.gettingToKnowOnJoin('bot-a', 'int-bot-a', 'C2')).toBe(true)
    expect(await d.gettingToKnowOnJoin('bot-a', 'int-bot-a', 'C9')).toBe(false)
    expect(
      await d.store.assistantItems.latestGettingToKnow('bot-a', {
        platform: 'slack',
        channel: 'C2',
        transportScope: scope
      })
    ).toBeUndefined()
    // A follow-up taken in a run there belongs to the origin conversation and replies in the task's thread.
    const take = vi.spyOn(d.followUpChecks, 'take').mockResolvedValue({ ok: true })
    d.activeTurnShare.set(taskKey, {
      platform: 'slack',
      channel: 'C2',
      thread: 'C2',
      headless: false,
      synthetic: false
    })
    await d.mcp.deps.assistantItems.take(booted.live.task, { title: 'Watch PR #12', doneWhen: 'it merges' })
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { platform: 'slack', channel: 'C1', transportScope: scope },
        replyThread: '1.1'
      })
    )
    d.activeTurnShare.delete(taskKey)
    await booted.daemon.stop()
  })

  it('keeps the task while its coordinator’s conversation runs auto, and closes it when its channel is archived', async () => {
    const booted = await boot()
    const { d, taskKey } = booted
    await booted.delegate()
    const index = d.store.assistantSubsessions
    // The channel's own row may read anything; the task goes with its coordinator's conversation.
    d.agents.get('bot-a').integrations[0].core.sessionModes = [{ channel: 'C1', mode: 'auto' }]
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', taskKey)).toBeDefined()
    await d.closeTaskPlace({ platform: 'slack', channel: 'C2', thread: 'C2' }, ['int-bot-a'])
    expect(await index.get('bot-a', taskKey)).toBeUndefined()
    expect(await index.threadsOf('bot-a', taskKey)).toEqual([])
    await booted.daemon.stop()
  })
})
