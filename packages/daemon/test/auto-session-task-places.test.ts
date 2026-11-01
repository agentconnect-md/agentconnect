// auto-session-mode.md §6.8: a coordinator's task in a conversation of its own (a Slack code channel), and its fallback to the thread.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import {
  CoordinatorSessions,
  deliveredMessage,
  TASK_PLACE_OPENING_MS
} from '../src/auto-session/coordinator-sessions.js'
import { wholeRoomThread } from '../src/auto-session/coordinator-turns.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { executeTool } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import type { TaskPlace } from '../src/platforms/contract.js'
import { coordinatorCoordinate } from '../src/session/append-coordinate.js'
import { buildStandingContext, PLACE_TASK_APPEND, THREADED_TASK_APPEND } from '../src/session/turn/standing-context.js'
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

describe('a coordinator task in a place of its own', () => {
  const COORDINATOR = coordinatorCoordinate(1)
  const coordinatorKey = sessionKey('slack', 'C1', COORDINATOR, 'bot-a')
  const placeKey = sessionKey('slack', 'C2', 'C2', 'bot-a')

  async function setup(openTaskPlace: (msg: NormalizedMessage) => Promise<TaskPlace | undefined>) {
    const store = await openTestStore()
    let now = 1_000
    const dispatched: NormalizedMessage[] = []
    const posted: { thread?: string; text: string }[] = []
    const reported: string[] = []
    const warnings: string[] = []
    const opened = vi.fn(async (_agentId: string, _integrationId: string | undefined, msg: NormalizedMessage) =>
      openTaskPlace(msg)
    )
    const sessions = new CoordinatorSessions({
      store: () => store,
      now: () => now,
      dispatch: (_agentId, msg) => void dispatched.push(msg),
      post: async (_agentId, _integrationId, msg, text) => void posted.push({ thread: msg.thread, text }),
      showTriaging: () => () => {},
      sessionLink: (sessionId) => `https://console.example.test/sessions/${sessionId}`,
      reportTaskOwners: async (_agentId, keys) => void reported.push(...keys),
      openTaskPlace: opened,
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
    const advance = (ms: number) => void (now += ms)
    return { store, sessions, ctx, begin, dispatched, posted, reported, warnings, opened, advance }
  }

  it('opens the task in the place the platform made for its message, links it there, and lets the copy start it', async () => {
    const { store, sessions, ctx, begin, dispatched, posted, reported, opened } = await setup(async () => ({
      channel: 'C2',
      thread: 'C2'
    }))
    begin(slack('1.1', { text: 'fix the flaky test' }))
    const receipt = await sessions.decide(ctx, {
      action: 'delegateTask',
      messageId: 'msg-1.1',
      title: 'Flaky test',
      message: 'it fails on main only'
    })
    expect(receipt).toMatchObject({ ok: true, taskId: placeKey, note: expect.stringContaining('of its own') })
    expect(opened).toHaveBeenCalledWith(
      'bot-a',
      'int-bot-a',
      expect.objectContaining({ msgId: 'slack:C1:1.1' }),
      'Flaky test'
    )
    const index = store.assistantSubsessions
    expect(await index.get('bot-a', placeKey)).toMatchObject({
      parentSessionKey: coordinatorKey,
      title: 'Flaky test',
      background: 'it fails on main only',
      state: 'open'
    })
    // The place is the task's one thread; the message's own thread stays the coordinator's.
    expect(await index.threadsOf('bot-a', placeKey)).toEqual([
      expect.objectContaining({ platform: 'slack', channel: 'C2', thread: 'C2', sinceRound: 1 })
    ])
    expect(await index.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '1.1' })).toBeUndefined()
    expect(reported).toEqual([placeKey])
    expect(posted).toEqual([{ thread: '1.1', text: `Started a task: [Flaky test](${LINK})` }])
    // The platform copies the message into its place, so nothing is dispatched to the task here.
    expect(dispatched).toEqual([])

    // That copy, which its sender posts there, carries the coordinator's title and background, once.
    const copy = slack('2.1', { msgId: 'slack:C2:2.1', channel: 'C2', thread: 'C2', text: 'fix the flaky test' })
    await sessions.placeOpening('bot-a', sessionKey('slack', 'C2', 'C2', 'other-agent'), copy)
    expect(copy.initialSessionTitle).toBeUndefined()
    const someoneElse = slack('2.0', {
      msgId: 'slack:C2:2.0',
      channel: 'C2',
      thread: 'C2',
      sender: { id: 'U2', isBot: false }
    })
    await sessions.placeOpening('bot-a', placeKey, someoneElse)
    expect(someoneElse.initialSessionTitle).toBeUndefined()
    await sessions.placeOpening('bot-a', placeKey, copy)
    expect(copy).toMatchObject({ text: 'fix the flaky test', initialSessionTitle: 'Flaky test' })
    expect(copy.turnBody?.prompt).toContain('it fails on main only')
    const next = slack('2.2', { msgId: 'slack:C2:2.2', channel: 'C2', thread: 'C2' })
    await sessions.placeOpening('bot-a', placeKey, next)
    expect(next.initialSessionTitle).toBeUndefined()
    expect(next.turnBody).toBeUndefined()
  })

  it('holds a copy that arrives while its place is being made until the task and its opening are kept', async () => {
    let created!: (place: TaskPlace) => void
    const { store, sessions, ctx, begin } = await setup(() => new Promise<TaskPlace>((resolve) => (created = resolve)))
    begin(slack('1.1', { text: 'fix the flaky test' }))
    const decided = sessions.decide(ctx, {
      action: 'delegateTask',
      messageId: 'msg-1.1',
      title: 'Flaky test',
      message: 'it fails on main only'
    })
    await vi.waitFor(() => expect(created).toBeDefined())
    // Slack delivers its copy before answering the creation.
    const copy = slack('2.1', { msgId: 'slack:C2:2.1', channel: 'C2', thread: 'C2', text: 'fix the flaky test' })
    let indexed: unknown
    const admitted = sessions.placeOpening('bot-a', placeKey, copy).then(async () => {
      indexed = await store.assistantSubsessions.get('bot-a', placeKey)
    })
    // A message elsewhere does not wait for it.
    const elsewhere = slack('3.1', { text: 'unrelated' })
    await sessions.placeOpening('bot-a', sessionKey('slack', 'C1', '3.1', 'bot-a'), elsewhere)
    expect(indexed).toBeUndefined()
    created({ channel: 'C2', thread: 'C2' })
    await admitted
    await decided
    expect(indexed).toMatchObject({ title: 'Flaky test' })
    expect(copy).toMatchObject({ initialSessionTitle: 'Flaky test' })
    expect(copy.turnBody?.prompt).toContain('it fails on main only')
  })

  it('lets a copy that comes too late open the task without the coordinator’s words', async () => {
    const { sessions, ctx, begin, advance } = await setup(async () => ({ channel: 'C2', thread: 'C2' }))
    begin(slack('1.1'))
    await sessions.decide(ctx, { action: 'delegateTask', messageId: 'msg-1.1', title: 'Flaky test', message: 'x' })
    advance(TASK_PLACE_OPENING_MS + 1)
    const copy = slack('2.1', { msgId: 'slack:C2:2.1', channel: 'C2', thread: 'C2' })
    await sessions.placeOpening('bot-a', placeKey, copy)
    expect(copy.initialSessionTitle).toBeUndefined()
  })

  it.each([
    ['makes no place', async () => undefined, 0],
    [
      'fails to make one',
      async () => {
        throw new Error('missing_scope')
      },
      1
    ]
  ])('keeps the task in the message’s thread when the platform %s', async (_label, place, warned) => {
    const { store, sessions, ctx, begin, dispatched, posted, warnings } = await setup(place)
    begin(slack('1.1', { text: 'fix the flaky test' }))
    const receipt = await sessions.decide(ctx, { action: 'delegateTask', messageId: 'msg-1.1', title: 'Flaky test' })
    const threadKey = sessionKey('slack', 'C1', '1.1', 'bot-a')
    expect(receipt).toMatchObject({
      ok: true,
      taskId: threadKey,
      note: "Task opened; it answers in the message's thread."
    })
    expect(dispatched.map((msg) => msg.msgId)).toEqual(['slack:C1:1.1'])
    expect(posted).toEqual([])
    expect(await store.assistantSubsessions.get('bot-a', placeKey)).toBeUndefined()
    expect(warnings).toHaveLength(warned)
  })

  it('moves a message it hands the task into the place, leaving its thread the coordinator’s', async () => {
    const { store, sessions, ctx, begin, dispatched, posted } = await setup(async () => ({
      channel: 'C2',
      thread: 'C2'
    }))
    begin(slack('1.1'))
    await sessions.decide(ctx, { action: 'delegateTask', messageId: 'msg-1.1', title: 'Flaky test' })
    begin(slack('3.2', { thread: '3.1', text: 'is it fixed on main too?', replyThread: '3.1' }))
    const receipt = await sessions.decide(ctx, {
      action: 'messageTask',
      messageId: 'msg-3.2',
      taskId: placeKey,
      message: 'they asked in another thread'
    })
    expect(receipt).toMatchObject({ ok: true, taskId: placeKey, note: expect.stringContaining('moved') })
    expect(dispatched).toHaveLength(1)
    const moved = dispatched[0]!
    expect(moved).toMatchObject({ msgId: 'slack:C1:3.2', channel: 'C2', thread: 'C2', isDm: false })
    expect(moved.replyThread).toBeUndefined()
    expect(moved.sessionThread).toBeUndefined()
    expect(moved.headless).toBeUndefined()
    expect(moved.turnBody?.prompt).toContain('they asked in another thread')
    // It never takes the opening the platform's copy of the task's own message is waiting for.
    await sessions.placeOpening('bot-a', placeKey, moved)
    expect(moved.initialSessionTitle).toBeUndefined()
    expect(posted.at(-1)).toEqual({ thread: '3.1', text: `Passed to [Flaky test](${LINK})` })
    expect(
      await store.assistantSubsessions.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '3.1' })
    ).toBeUndefined()
  })

  it('opens a fallback task for a mention in its thread, never in a place (§4.5)', async () => {
    const { sessions, begin, dispatched, opened } = await setup(async () => ({ channel: 'C2', thread: 'C2' }))
    begin(slack('1.1', { trigger: 'mention', text: '<@UBOT> thoughts?' }))
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'failed')
    expect(opened).not.toHaveBeenCalled()
    expect(dispatched.map((msg) => msg.msgId)).toEqual(['slack:C1:1.1'])
  })

  it('tells a task in its place where it is and who reads it', () => {
    const base = {
      agentName: 'bot-a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C2',
      thread: 'C2',
      envSecretNames: [],
      fileSecrets: [],
      memoryIndex: '',
      usesMeta: false
    }
    const placed = buildStandingContext({ ...base, threadedTask: true, placeTask: true }).sessionContext
    expect(placed).toContain(PLACE_TASK_APPEND)
    expect(placed).not.toContain(THREADED_TASK_APPEND)
  })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-task-place-'))
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

describe('a coordinator task in a Slack code channel, through the daemon (auto-session-mode.md §6.8)', () => {
  async function boot(fullMember = true) {
    const live: { d?: any; ctx?: SessionContext } = {}
    const coordinatorTurns: string[] = []
    const taskTurns: { sessionId: string; text: string }[] = []
    let sessions = 0
    let onUpdate: (sessionId: string, update: unknown) => void = () => {}
    const host = {
      __started: true,
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => `acp-${++sessions}`),
      prompt: vi.fn(async (sessionId: string, blocks: { type: string; text?: string }[]) => {
        const prompt = blocks.map((block) => block.text ?? '').join('\n')
        const ids = [...prompt.matchAll(/<message id="(msg-[^"]+)"/g)].map((match) => match[1]!)
        if (ids.length === 0) {
          taskTurns.push({ sessionId, text: prompt })
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
    vi.spyOn(d.placeMembers, 'isFullMember').mockResolvedValue(fullMember)
    const openTaskPlace = vi.fn(async (): Promise<TaskPlace> => ({ channel: 'C2', thread: 'C2' }))
    vi.spyOn(d, 'anyConnForIntegration').mockReturnValue({
      openTaskPlace,
      workspaceUrl: 'https://workspace.example.test'
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
    const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
    const idle = async () => await vi.waitFor(() => expect(d.pending.size + d.inflight.size).toBe(0), WAIT)
    const placeKey = sessionKey('slack', 'C2', 'C2', 'bot-a', scope)
    const coordinatorKey = sessionKey('slack', 'C1', coordinator, 'bot-a', scope)
    return {
      daemon,
      d,
      ctx: live.ctx!,
      scope,
      placeKey,
      coordinatorKey,
      route,
      idle,
      coordinatorTurns,
      taskTurns,
      taskPosts,
      coordinatorPosts,
      openTaskPlace
    }
  }

  // Slack's copy of the request, as its code channel discovery canonicalizes it.
  const copy = (ts: string, text: string) =>
    slack(ts, { msgId: `slack:C2:${ts}`, channel: 'C2', thread: 'C2', text, conversationBotId: 'U_FAKE_BOT' })

  it('opens the channel for the message, and the copy Slack brings there starts the task as its one session', async () => {
    const booted = await boot()
    const { d, placeKey, coordinatorKey } = booted
    await booted.route(slack('1.1', { text: 'fix the flaky test' }))
    await vi.waitFor(() => expect(booted.coordinatorPosts).toHaveLength(1), WAIT)
    await booted.idle()
    expect(booted.openTaskPlace).toHaveBeenCalledWith(
      { agentId: 'bot-a', channel: 'C1', messageId: '1.1', isDm: false },
      'Flaky test'
    )
    // The message's thread links the channel, by the link its platform gives it.
    expect(booted.coordinatorPosts).toEqual([
      {
        channel: 'C1',
        thread: '1.1',
        text: expect.stringMatching(/^Started a task: \[Flaky test\]\(https:\/\/.+\/archives\/C2\)$/)
      }
    ])
    expect(booted.taskTurns).toEqual([])
    const index = d.store.assistantSubsessions
    expect(await index.get('bot-a', placeKey)).toMatchObject({ parentSessionKey: coordinatorKey, title: 'Flaky test' })
    // The coordinator lists it with its channel as its thread, linked.
    const listed = (await executeTool(booted.ctx, 'listTasks', {}, { ...d.mcp.deps, canRun: () => true })) as {
      here: { title: string; threaded: boolean; threads: { channel: string; thread: string; link?: string }[] }[]
    }
    expect(listed.here).toEqual([
      expect.objectContaining({
        title: 'Flaky test',
        threaded: true,
        threads: [{ channel: 'C2', thread: 'C2', link: expect.stringMatching(/\/archives\/C2$/) }]
      })
    ])

    await booted.route(copy('1.5', 'fix the flaky test'))
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(1), WAIT)
    await booted.idle()
    // One session, the channel's, with the coordinator's background and its place's standing context.
    expect(await d.store.getSession(placeKey)).toMatchObject({ channel: 'C2', thread: 'C2', title: 'Flaky test' })
    expect(booted.taskTurns[0]!.text).toContain('fix the flaky test')
    expect(booted.taskTurns[0]!.text).toContain('it fails on main only')
    expect(booted.taskTurns[0]!.text).toContain(PLACE_TASK_APPEND.split('\n')[1]!)
    // It answers in its channel; the harness's channel cannot confirm a Code view, which it also says there.
    expect(booted.taskPosts).toContainEqual({ channel: 'C2', thread: 'C2', text: 'on it' })
    expect(booted.taskPosts.every((post) => post.channel === 'C2')).toBe(true)
    // The channel is no conversation of its own to coordinate.
    expect(await d.store.currentAppendCoordinate('bot-a', 'C2', booted.scope, 'coordinator')).toBeUndefined()
    expect(booted.coordinatorTurns).toHaveLength(1)

    // A follow-up there reaches the same task.
    await booted.route(copy('1.6', 'and add a test'))
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(2), WAIT)
    await booted.idle()
    expect(booted.taskTurns[1]!.sessionId).toBe(booted.taskTurns[0]!.sessionId)
    expect(await index.get('bot-a', placeKey)).toMatchObject({ state: 'done', round: 2 })
    await booted.daemon.stop()
  })

  it('keys a code channel no task holds on its one session, never on a coordinator of its own', async () => {
    const booted = await boot()
    const calls: NormalizedMessage[] = []
    booted.d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    await booted.route(copy('1.5', 'fix the flaky test'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ channel: 'C2', thread: 'C2' })
    expect(calls[0]!.sessionThread).toBeUndefined()
    expect(await booted.d.store.currentAppendCoordinate('bot-a', 'C2', booted.scope, 'coordinator')).toBeUndefined()
    // A DM keyed as one thread is no room: it still has its coordinator where it runs auto.
    expect(wholeRoomThread({ channel: 'D1', thread: 'D1', isDm: true })).toBe(false)
    expect(wholeRoomThread({ channel: 'C2', thread: 'C2', isDm: false })).toBe(true)
    expect(wholeRoomThread({ channel: 'C1', thread: '1.1', isDm: false })).toBe(false)
    await booted.daemon.stop()
  })

  it('keeps the task while its coordinator’s conversation runs auto, and closes it when its channel is archived', async () => {
    const booted = await boot()
    const { d, placeKey } = booted
    await booted.route(slack('1.1', { text: 'fix the flaky test' }))
    await vi.waitFor(() => expect(booted.coordinatorPosts).toHaveLength(1), WAIT)
    await booted.idle()
    const index = d.store.assistantSubsessions
    // The place's own row may read anything; the task goes with its coordinator's conversation.
    d.agents.get('bot-a').integrations[0].core.sessionModes = [{ channel: 'C1', mode: 'auto' }]
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', placeKey)).toBeDefined()
    await d.closeTaskPlace({ platform: 'slack', channel: 'C2', thread: 'C2' }, ['int-bot-a'])
    expect(await index.get('bot-a', placeKey)).toBeUndefined()
    expect(await index.threadsOf('bot-a', placeKey)).toEqual([])
    await booted.daemon.stop()
  })

  it('releases the task when its coordinator’s conversation leaves auto, whatever its place reads', async () => {
    const booted = await boot()
    const { d, placeKey } = booted
    await booted.route(slack('1.1', { text: 'fix the flaky test' }))
    await vi.waitFor(() => expect(booted.coordinatorPosts).toHaveLength(1), WAIT)
    await booted.idle()
    d.agents.get('bot-a').integrations[0].core.sessionModes = [{ channel: 'C2', mode: 'auto' }]
    await d.leaveAutoConversations()
    expect(await d.store.assistantSubsessions.get('bot-a', placeKey)).toBeUndefined()
    await booted.daemon.stop()
  })

  it('keeps the task in the message’s thread when its sender may not have the agent make a channel', async () => {
    const booted = await boot(false)
    await booted.route(slack('1.1', { text: 'fix the flaky test' }))
    await vi.waitFor(() => expect(booted.taskTurns).toHaveLength(1), WAIT)
    await booted.idle()
    expect(booted.openTaskPlace).not.toHaveBeenCalled()
    expect(booted.coordinatorPosts).toEqual([])
    expect(booted.taskPosts).toEqual([{ channel: 'C1', thread: '1.1', text: 'on it' }])
    await booted.daemon.stop()
  })
})
