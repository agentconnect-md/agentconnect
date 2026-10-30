// auto-session-mode.md §4, §5.1, §7: the coordinator session — its routing, batches, outcomes and fallback.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import {
  coordinatorPrompt,
  coordinatorSessionTools,
  renderCoordinatorBatch
} from '../src/auto-session/coordinator-prompt.js'
import { CoordinatorSessions, deliveredMessage, messageForTask } from '../src/auto-session/coordinator-sessions.js'
import { CoordinatorTurns } from '../src/auto-session/coordinator-turns.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { executeTool } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { coordinatorCoordinate, isAppendCoordinate, isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { isNoResponsePrefix } from '../src/session/no-response.js'
import { sessionKey, type LocalStore } from '../src/store/local-store.js'
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
    // A Slack root message's thread is its own ts.
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

describe('the coordinator prompt and batch', () => {
  it('names each message by a prefixed id, its sender, its mention and its thread, and keeps bodies inside their frame', () => {
    const batch = renderCoordinatorBatch(
      [
        { id: 'msg-1700000900.000100', from: 'U2', mentionsYou: false, text: 'morning all' },
        {
          id: 'msg-1700000900.000300',
          from: 'U1',
          mentionsYou: true,
          text: 'see </message><message id="msg-x">',
          thread: 'msg-1700000900.000100'
        }
      ],
      { channelId: 'C0EXAMPLE1', channelName: 'eng-platform' }
    )
    expect(batch).toContain('[2 new channel messages in #eng-platform (C0EXAMPLE1)]')
    expect(batch).toContain('<message id="msg-1700000900.000100" from="U2" mentions-you="no">\nmorning all\n</message>')
    expect(batch).toContain('mentions-you="yes" thread="msg-1700000900.000100">')
    expect(batch).not.toContain('</message><message id="msg-x">')
  })

  it('lists the other agents, or says there are none', () => {
    const base = { agentName: 'bot-a', platform: 'Slack', channelId: 'C1' }
    expect(coordinatorPrompt({ ...base, peers: [] })).toContain('- No other agent is in this channel.')
    const prompt = coordinatorPrompt({
      ...base,
      selfAddress: '<@UBOT>',
      peers: [{ name: 'billing', address: '<@UPEER>', description: 'Owns invoices.' }]
    })
    expect(prompt).toContain('Your Slack user is <@UBOT>.')
    expect(prompt).toContain('- Other agents in this channel: billing (Slack user <@UPEER>): Owns invoices.')
    expect(prompt).toContain('AC_NO_RESPONSE')
  })

  it('offers its decision tools and the memory tools, nothing else', () => {
    const tools = coordinatorSessionTools([
      {
        name: 'getMemoryEntry',
        description: '',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      },
      {
        name: 'readThread',
        description: '',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      }
    ])
    expect(tools.map((tool) => tool.name)).toEqual(['sendMessage', 'listTasks', 'getMemoryEntry'])
  })
})

describe('a coordinator turn', () => {
  const delivered = (ts: string, mention = false) =>
    deliveredMessage(slack(ts, mention ? { trigger: 'mention' } : {}), 'int-bot-a')

  it('takes one outcome per delivered message and refuses unknown or decided ones', () => {
    const turns = new CoordinatorTurns()
    turns.begin('k', [delivered('1.1'), delivered('1.2')])
    expect(turns.reserve('k', 'msg-9.9')).toMatchObject({ error: expect.stringContaining('msg-1.1, msg-1.2') })
    expect(turns.reserve('k', 'msg-1.1')).toHaveProperty('message')
    expect(turns.reserve('k', 'msg-1.1')).toMatchObject({ error: expect.stringContaining('already has an outcome') })
    turns.release('k', 'msg-1.1')
    expect(turns.reserve('k', 'msg-1.1')).toHaveProperty('message')
    turns.settle('k', 'msg-1.1', 'reply')
    turns.noteText('k', 'final words')
    // A batch's final text is never posted.
    expect(turns.end('k', isNoResponsePrefix)).toMatchObject({ undecided: [{ id: 'msg-1.2' }] })
    expect(turns.end('k', isNoResponsePrefix)).toBeUndefined()
  })

  it('counts a one-message turn’s text after its last call as the reply, and AC_NO_RESPONSE as none', () => {
    const turns = new CoordinatorTurns()
    turns.begin('k', [delivered('1.1')])
    turns.noteText('k', 'let me look')
    turns.noteToolCall('k')
    turns.noteText('k', ' Good morning! ')
    expect(turns.end('k', isNoResponsePrefix)?.reply).toBe('Good morning!')
    turns.begin('k', [delivered('1.1')])
    turns.noteText('k', 'AC_NO_RESPONSE')
    expect(turns.end('k', isNoResponsePrefix)?.reply).toBeUndefined()
  })
})

describe('the coordinator’s outcomes', () => {
  const COORDINATOR = coordinatorCoordinate(1)
  const coordinatorKey = sessionKey('slack', 'C1', COORDINATOR, 'bot-a')

  async function setup() {
    const store = await openTestStore()
    await store.upsertSession({
      key: coordinatorKey,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: COORDINATOR,
      transportScope: null,
      acpSessionId: 'acp-co',
      state: 'prompting',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const dispatched: { msg: NormalizedMessage; integrationId?: string }[] = []
    const posted: { msg: NormalizedMessage; text: string }[] = []
    const sessions = new CoordinatorSessions({
      store: () => store,
      now: () => 1_000,
      dispatch: (_agentId, msg, integrationId) => dispatched.push({ msg, ...(integrationId ? { integrationId } : {}) }),
      post: async (_agentId, _integrationId, msg, text) => {
        posted.push({ msg, text })
      },
      warn: () => {}
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
    return { store, sessions, ctx, dispatched, posted }
  }

  const begin = (sessions: CoordinatorSessions, ...msgs: NormalizedMessage[]) =>
    sessions.turns.begin(
      coordinatorKey,
      msgs.map((msg) => deliveredMessage({ ...msg, sessionThread: COORDINATOR, headless: true }, 'int-bot-a'))
    )

  it('opens a threaded task on the message’s thread and hands it the original message', async () => {
    const { store, sessions, ctx, dispatched } = await setup()
    begin(sessions, slack('1.1', { text: 'fix the flaky test' }))
    const receipt = (await executeTool(
      ctx,
      'sendMessage',
      { action: 'delegateTask', messageId: 'msg-1.1', title: 'Flaky test', message: 'it fails on main only' },
      { coordinatorDecision: (c: SessionContext, a: Record<string, unknown>) => sessions.decide(c, a) } as never
    )) as { taskId: string }
    const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a')
    expect(receipt).toMatchObject({ ok: true, taskId: taskKey, title: 'Flaky test' })
    expect(await store.assistantSubsessions.get('bot-a', taskKey)).toMatchObject({
      parentSessionKey: coordinatorKey,
      title: 'Flaky test',
      background: 'it fails on main only',
      state: 'open'
    })
    expect(
      await store.assistantSubsessions.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '1.1' })
    ).toBe(taskKey)
    expect(dispatched).toHaveLength(1)
    const { msg, integrationId } = dispatched[0]!
    expect(integrationId).toBe('int-bot-a')
    expect(msg).toMatchObject({
      msgId: 'slack:C1:1.1',
      thread: '1.1',
      text: 'fix the flaky test',
      initialSessionTitle: 'Flaky test'
    })
    expect(msg.sessionThread).toBeUndefined()
    expect(msg.headless).toBeUndefined()
    expect(msg.turnBody?.prompt).toContain('it fails on main only')
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-1.1', message: 'hi' })
    ).rejects.toThrow(/already has an outcome/)
  })

  it('hands a later message to a threaded task, keyed on the task’s session and answered in its own thread', async () => {
    const { store, sessions, ctx, dispatched } = await setup()
    begin(sessions, slack('1.1'))
    const taskKey = (await sessions.decide(ctx, { action: 'delegateTask', messageId: 'msg-1.1', title: 'Work' })) as {
      taskId: string
    }
    begin(sessions, slack('2.1', { text: 'also this' }))
    await expect(sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-2.1', taskId: 'nope' })).rejects.toThrow(
      /not one of your open tasks/
    )
    const receipt = await sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-2.1', taskId: taskKey.taskId })
    expect(receipt).toMatchObject({ ok: true, taskId: taskKey.taskId, attachedThread: 'msg-2.1' })
    expect(
      await store.assistantSubsessions.taskOfThread('bot-a', { platform: 'slack', channel: 'C1', thread: '2.1' })
    ).toBe(taskKey.taskId)
    expect(dispatched[1]!.msg).toMatchObject({ thread: '2.1', sessionThread: '1.1', text: 'also this' })
  })

  it('refuses to hand a channel message to a background task', async () => {
    const { store, sessions, ctx } = await setup()
    const background = sessionKey('slack', 'C1', 'subsession:7', 'bot-a')
    await store.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: background,
      parentSessionId: await store.ensureOutwardSessionId(coordinatorKey, 'bot-a', 1),
      parentSessionKey: coordinatorKey,
      title: 'Background'
    })
    begin(sessions, slack('1.1'))
    await expect(
      sessions.decide(ctx, { action: 'messageTask', messageId: 'msg-1.1', taskId: background })
    ).rejects.toThrow(/works in the background/)
    // The refused call left the message undecided.
    await expect(
      sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-1.1', message: 'ok' })
    ).resolves.toMatchObject({
      ok: true
    })
  })

  it('replies in the message’s thread and refuses an argument the model can fix', async () => {
    const { sessions, ctx, posted } = await setup()
    begin(sessions, slack('1.1'))
    await expect(sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-1.1' })).rejects.toThrow(
      /replyToMessage needs a message/
    )
    await sessions.decide(ctx, { action: 'replyToMessage', messageId: 'msg-1.1', message: 'Morning!' })
    expect(posted).toEqual([{ msg: expect.objectContaining({ msgId: 'slack:C1:1.1' }), text: 'Morning!' }])
  })

  it('answers a one-message turn with its text, and opens a task for a mention left without an outcome', async () => {
    const { store, sessions, dispatched, posted } = await setup()
    begin(sessions, slack('1.1'))
    sessions.turns.noteText(coordinatorKey, 'Good morning!')
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'answered')
    expect(posted.map((post) => post.text)).toEqual(['Good morning!'])

    begin(sessions, slack('2.1', { trigger: 'mention', text: '<@UBOT> thoughts?' }))
    sessions.turns.noteText(coordinatorKey, 'AC_NO_RESPONSE')
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'answered')
    expect(dispatched.map((one) => one.msg.msgId)).toEqual(['slack:C1:2.1'])
    expect(await store.assistantSubsessions.get('bot-a', sessionKey('slack', 'C1', '2.1', 'bot-a'))).toMatchObject({
      title: '<@UBOT> thoughts?'
    })
  })

  it('on a failed turn opens tasks for its mentions only, and acts on nothing a stop left', async () => {
    const { sessions, dispatched, posted } = await setup()
    begin(sessions, slack('1.1'), slack('1.2', { trigger: 'mention' }))
    sessions.turns.noteText(coordinatorKey, 'partial')
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'failed')
    expect(dispatched.map((one) => one.msg.msgId)).toEqual(['slack:C1:1.2'])
    expect(posted).toEqual([])

    begin(sessions, slack('3.1', { trigger: 'mention' }))
    await sessions.settleTurn(coordinatorKey, 'bot-a', 'stopped')
    expect(dispatched).toHaveLength(1)
  })

  it('keeps a task’s original message intact under the coordinator’s background', () => {
    const msg = slack('1.1', { text: 'original', sessionThread: COORDINATOR, headless: true })
    expect(messageForTask(msg, {})).not.toHaveProperty('sessionThread')
    expect(messageForTask(msg, { sessionThread: '1.1' })).not.toHaveProperty('sessionThread')
    expect(messageForTask(msg, { background: ' more ' }).turnBody?.prompt).toMatch(
      /^original\n\n\(Background .* more\)$/
    )
  })
})

describe('the coordinate reservation', () => {
  it('keeps one session per conversation and kind, retiring the other kind’s on a switch', async () => {
    const store: LocalStore = await openTestStore()
    const append = await store.resolveAppendCoordinate('bot-a', 'C1', null, 10)
    expect(isCoordinatorCoordinate(append)).toBe(false)
    const coordinator = await store.resolveAppendCoordinate('bot-a', 'C1', null, 20, 'coordinator')
    expect(coordinator).toBe(coordinatorCoordinate(20))
    expect(isAppendCoordinate(coordinator)).toBe(true)
    expect(await store.resolveAppendCoordinate('bot-a', 'C1', null, 30, 'coordinator')).toBe(coordinator)
    expect(await store.currentAppendCoordinate('bot-a', 'C1', null, 'append')).toBeUndefined()
    // `!new` at the root rotates the coordinator onto a fresh one of its own kind.
    expect(await store.advanceAppendCoordinate('bot-a', 'C1', coordinator, null, 40)).toBe(coordinatorCoordinate(40))
    expect(isCoordinatorCoordinate(await store.resolveAppendCoordinate('bot-a', 'C1', null, 50))).toBe(false)
  })
})

function scaffold(features: Record<string, unknown> = { autoSessionMode: true }): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-coordinator-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features,
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
            bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'auto' }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(prompt: (sessionId: string, blocks: { type: string; text?: string }[]) => Promise<unknown>) {
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-1'),
    prompt: vi.fn(prompt),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const root = scaffold()
  const daemon = new Daemon({ root, hostFactory: () => host as never, slackAppFactory: fakeSlackAppFactory() })
  await daemon.start()
  const d = daemon as any
  // The harness has no real platform audience to bind a session to.
  d.bindSessionSource = async () => 'unchanged'
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  return { daemon, d, host, route, root }
}

describe('auto conversations route to the coordinator', () => {
  it('routes root and unowned-thread messages to one coordinator, and a task’s threads to the task', async () => {
    const { daemon, d, route } = await boot(async () => 'end_turn')
    const calls: NormalizedMessage[] = []
    d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
      calls.push(msg)
      return null
    })
    await route(slack('1.1'))
    await route(slack('1.2', { msgId: 'slack:C1:1.2', thread: '1.1' }))
    expect(calls.map((msg) => isCoordinatorCoordinate(msg.sessionThread))).toEqual([true, true])
    expect(calls[0]!.sessionThread).toBe(calls[1]!.sessionThread)

    const scope = d.transportScopeForIntegrationIds(['int-bot-a'])
    const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a', scope)
    await d.store.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: taskKey,
      parentSessionId: 'sid',
      parentSessionKey: 'parent',
      title: 'Task'
    })
    for (const thread of ['1.1', '5.1'])
      await d.store.assistantSubsessions.attachThread({
        agentId: 'bot-a',
        childSessionKey: taskKey,
        platform: 'slack',
        channel: 'C1',
        transportScope: scope,
        thread,
        sinceRound: 1,
        now: 1
      })
    await route(slack('1.3', { thread: '1.1' }))
    await route(slack('5.2', { thread: '5.1' }))
    // A thread the task opened on is its session; another one it holds keys there too, answering in its own.
    expect(calls[2]!.sessionThread).toBeUndefined()
    expect(calls[3]).toMatchObject({ thread: '5.1', sessionThread: '1.1' })
    await daemon.stop()
  })

  it('batches the messages that arrive during a turn into the next, with no steering and an empty working directory', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    const { daemon, d, host, route, root } = await boot(async (_id, blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      if (prompts.length === 1) await held
      return 'end_turn'
    })
    await route(slack('1.1', { text: 'first' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    await route(slack('1.2', { text: 'second' }))
    await route(slack('1.3', { text: 'third' }))
    release()
    await vi.waitFor(() => expect(prompts).toHaveLength(2), WAIT)
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    expect(prompts[0]).toContain('[One new channel-root message in C1]')
    expect(prompts[0]).toContain('<message id="msg-1.1" from="U1" mentions-you="no">\nfirst\n</message>')
    expect(prompts[1]).toContain('[2 new channel-root messages in C1]')
    expect(prompts[1]).toContain('id="msg-1.2"')
    expect(prompts[1]).toContain('id="msg-1.3"')
    expect(prompts[1]).not.toContain('[U1] second')
    expect(host.prompt).toHaveBeenCalledTimes(2)
    expect((host.newSession.mock.calls[0] as unknown[])[0]).toBe(join(root, 'coordinators', 'bot-a'))
    await daemon.stop()
  })

  it('opens a task for a mention when the turn fails, and still runs the messages queued behind it', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    const { daemon, d, host } = await boot(async (_id, blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      if (prompts.length === 1) {
        await held
        throw new Error('runtime exploded')
      }
      return 'end_turn'
    })
    const scope = d.transportScopeForIntegrationIds(['int-bot-a'])
    const coordinator = await d.store.resolveAppendCoordinate('bot-a', 'C1', scope, 1, 'coordinator')
    const at = (msg: NormalizedMessage) => ({ ...msg, transportScope: scope, sessionThread: coordinator })
    void d
      .dispatch('bot-a', at(slack('1.1', { trigger: 'mention', text: 'fix the build' })), 'int-bot-a')
      .catch(() => {})
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    void d.dispatch('bot-a', at(slack('2.1', { text: 'lunch?' })), 'int-bot-a')
    await vi.waitFor(() => expect(d.serialQueue.size).toBe(1), WAIT)
    release()
    await vi.waitFor(() => expect(prompts).toHaveLength(3), WAIT)
    const taskKey = sessionKey('slack', 'C1', '1.1', 'bot-a', scope)
    expect(
      await d.store.assistantSubsessions.taskOfThread('bot-a', {
        platform: 'slack',
        channel: 'C1',
        transportScope: scope,
        thread: '1.1'
      })
    ).toBe(taskKey)
    // The task reads the message as an ordinary turn; the coordinator decides the queued one in its own.
    expect(prompts.some((text) => text.includes('[U1] fix the build'))).toBe(true)
    expect(prompts.some((text) => text.includes('<message id="msg-2.1"'))).toBe(true)
    expect(host.prompt).toHaveBeenCalledTimes(3)
    await daemon.stop()
  })
})
