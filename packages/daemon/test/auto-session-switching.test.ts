// auto-session-mode.md §3.3, §3.5: Any message under auto, and switching a conversation into and out of it.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { Daemon } from '../src/daemon.js'
import { THREADED_TASK_IDLE_CLOSE_MS } from '../src/auto-session/coordinator-sessions.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isAppendCoordinate, isCoordinatorCoordinate } from '../src/session/append-coordinate.js'
import { sessionKey, type SessionRecord } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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

const mention = { mentionedBots: ['U_FAKE_BOT'], text: '<@U_FAKE_BOT> and now?' }

type Mode = 'createNew' | 'append' | 'auto'

function scaffold(mode: Mode): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-auto-switch-'))
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
          // Mention only: under auto the daemon admits Any message itself (§3.3).
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: mode === 'createNew' ? [] : [{ channel: 'C1', mode }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(mode: Mode) {
  const clock = new FakeClock(Date.now())
  const daemon = new Daemon({
    root: scaffold(mode),
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: () => ({ __started: true, start: vi.fn(), stop: vi.fn() }) as never,
    clock
  })
  await daemon.start()
  const d = daemon as any
  const calls: NormalizedMessage[] = []
  d.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
    calls.push(msg)
    return null
  })
  const scope: string = d.transportScopeForIntegrationIds(['int-bot-a'])
  const index = d.store.assistantSubsessions
  const keyAt = (thread: string, channel = 'C1') => sessionKey('slack', channel, thread, 'bot-a', scope)
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  // Mode is read per message (channel-session-mode.md §3.4), so the switch is the live spec's.
  const setMode = (next: Mode) => {
    d.agents.get('bot-a').integrations[0].core.sessionModes =
      next === 'createNew' ? [] : [{ channel: 'C1', mode: next }]
  }
  const seed = async (thread: string, over: Partial<SessionRecord> = {}) => {
    const { title, ...row } = over
    await d.store.upsertSession({
      key: keyAt(thread, over.channel),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread,
      transportScope: scope,
      acpSessionId: `acp-${thread}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: clock.now(),
      ...row
    })
    if (title) await d.store.setSessionTitle(keyAt(thread, over.channel), title)
  }
  const coordinatorKey = async () => {
    const coordinate = await d.store.currentAppendCoordinate('bot-a', 'C1', scope, 'coordinator')
    return coordinate === undefined ? undefined : keyAt(coordinate)
  }
  const tasksOf = async (parentKey: string) =>
    (
      await index.listForOwner(
        'bot-a',
        { sessionId: await d.store.ensureOutwardSessionId(parentKey, 'bot-a'), key: parentKey },
        20
      )
    ).rows as { childSessionKey: string; title?: string; state: string }[]
  const at = (thread: string) => ({ platform: 'slack', channel: 'C1', transportScope: scope, thread })
  return { daemon, d, clock, calls, scope, index, keyAt, route, setMode, seed, coordinatorKey, tasksOf, at }
}

describe('the trigger under auto (auto-session-mode.md §3.3)', () => {
  it('brings every root message to the coordinator, mentioned or not, and only a mention under Per thread', async () => {
    const { daemon, calls, route, setMode } = await boot('createNew')
    await route(slack('1.1'))
    expect(calls).toEqual([])
    setMode('auto')
    await route(slack('2.1'))
    expect(calls.map((msg) => isCoordinatorCoordinate(msg.sessionThread))).toEqual([true])
    await daemon.stop()
  })
})

describe('switching into auto (auto-session-mode.md §3.5)', () => {
  it('makes the recent thread sessions the coordinator’s tasks, titled from their first message', async () => {
    const { daemon, d, clock, calls, scope, keyAt, route, setMode, seed, coordinatorKey, tasksOf, index, at } =
      await boot('createNew')
    await seed('1.1', { title: 'Fix the flaky test\nit fails on main only' })
    await seed('2.1', { title: 'Old question', updatedAt: clock.now() - THREADED_TASK_IDLE_CLOSE_MS - 1 })
    await seed('3.1', { title: 'Asked by another session', originSessionId: 'sid-caller' })
    await seed('subsession:d1', { title: 'A background task' })
    await seed('4.1', { channel: 'C2', title: 'Elsewhere' })
    setMode('auto')
    const emit = vi.spyOn(d.sessionMetadataOutbox, 'emitSessionMetadataSnapshot')

    // A reply in a thread from before the switch reaches its own session, now a task.
    await route(slack('1.5', { thread: '1.1' }))
    // §6.2: the adopted session's metadata names its coordinator now.
    expect(emit.mock.calls.map(([snapshot]: any[]) => snapshot.sessionKey)).toEqual([keyAt('1.1')])
    expect(calls[0]).toMatchObject({ thread: '1.1' })
    expect(calls[0]!.sessionThread).toBeUndefined()
    const parent = (await coordinatorKey())!
    expect((await tasksOf(parent)).map((row) => [row.childSessionKey, row.title, row.state])).toEqual([
      [keyAt('1.1'), 'Fix the flaky test', 'done']
    ])
    expect(await index.taskOfThread('bot-a', at('1.1'))).toBe(keyAt('1.1'))

    // A week-idle session, another session's child and the root reach the coordinator.
    await route(slack('2.5', { thread: '2.1' }))
    await route(slack('3.5', { thread: '3.1' }))
    await route(slack('9.1'))
    const coordinate = await d.store.currentAppendCoordinate('bot-a', 'C1', scope, 'coordinator')
    expect(calls.slice(1).map((msg) => msg.sessionThread)).toEqual([coordinate, coordinate, coordinate])
    await daemon.stop()
  })
})

describe('switching into auto while messages arrive', () => {
  it('holds a message that arrives while a new coordinator adopts until the adoption is done', async () => {
    const { daemon, d, calls, route, setMode, seed } = await boot('createNew')
    await seed('1.1', { title: 'Old thread' })
    setMode('auto')
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const adopt = d.coordinators.adoptThreadSessions.bind(d.coordinators)
    const adopting = vi.spyOn(d.coordinators, 'adoptThreadSessions').mockImplementation(async (...args: unknown[]) => {
      await held
      return await adopt(...args)
    })
    const root = route(slack('9.1'))
    await vi.waitFor(() => expect(adopting).toHaveBeenCalledTimes(1))
    const reply = route(slack('1.5', { thread: '1.1' }))
    await new Promise((resolve) => setImmediate(resolve))
    release()
    await Promise.all([root, reply])
    expect(adopting).toHaveBeenCalledTimes(1)
    expect(calls.find((msg) => msg.msgId === 'slack:C1:1.5')!.sessionThread).toBeUndefined()
    await daemon.stop()
  })
})

describe('switching out of auto (auto-session-mode.md §3.5)', () => {
  async function withTask(mode: Mode = 'auto') {
    const booted = await boot(mode)
    const { route, seed, keyAt, index, coordinatorKey, scope } = booted
    await route(slack('1.1'))
    const parent = (await coordinatorKey())!
    await seed('1.1', { title: 'Flaky test' })
    await index.open({
      agentId: 'bot-a',
      childSessionKey: keyAt('1.1'),
      parentSessionId: 'sid-coordinator',
      parentSessionKey: parent,
      title: 'Flaky test',
      now: 1
    })
    for (const thread of ['1.1', '5.1'])
      await index.attachThread({
        agentId: 'bot-a',
        childSessionKey: keyAt('1.1'),
        platform: 'slack',
        channel: 'C1',
        transportScope: scope,
        thread,
        sinceRound: 1,
        now: 1
      })
    await index.finish('bot-a', keyAt('1.1'), 'done')
    booted.calls.length = 0
    return { ...booted, parent }
  }

  it('retires the coordinator and hands its tasks back as ordinary thread sessions under Per thread', async () => {
    const { daemon, d, clock, calls, keyAt, route, setMode, index, at, coordinatorKey, parent, tasksOf } =
      await withTask()
    // While the mode is on, the sweep keeps both.
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', keyAt('1.1'))).toBeDefined()
    setMode('createNew')
    const emit = vi.spyOn(d.sessionMetadataOutbox, 'emitSessionMetadataSnapshot')
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', keyAt('1.1'))).toBeUndefined()
    // §6.2: released, its metadata names no owner, so its visibility is its sender's again.
    expect(emit.mock.calls.map(([snapshot]: any[]) => snapshot.sessionKey)).toEqual([keyAt('1.1')])
    emit.mockRestore()
    expect(await index.taskOfThread('bot-a', at('5.1'))).toBeUndefined()
    expect(await coordinatorKey()).toBeUndefined()
    expect(await d.store.getSession(keyAt('1.1'))).toBeDefined()

    // Per thread: its thread keys its own session, and the root no longer reaches a coordinator.
    await route(slack('1.6', { thread: '1.1', ...mention }))
    await route(slack('6.1', mention))
    expect(calls.map((msg) => msg.sessionThread)).toEqual([undefined, undefined])

    // Back into auto, a new coordinator takes the session again as its task.
    clock.advance(60_000)
    setMode('auto')
    await route(slack('7.1'))
    const next = (await coordinatorKey())!
    expect(next).not.toBe(parent)
    expect((await tasksOf(next)).map((row) => row.childSessionKey)).toEqual([keyAt('1.1')])
    await daemon.stop()
  })

  it('judges each conversation by the integration its transport scope names', async () => {
    const { daemon, d, keyAt, index, coordinatorKey } = await withTask()
    // Another bot of the agent, no longer listed in auto, left a task and a coordinator in the same channel id.
    const elsewhere = 'slack:another-bot'
    const foreignTask = sessionKey('slack', 'C1', '8.1', 'bot-a', elsewhere)
    await index.open({
      agentId: 'bot-a',
      childSessionKey: foreignTask,
      parentSessionId: 'sid-elsewhere',
      parentSessionKey: 'elsewhere-coordinator',
      now: 1
    })
    await index.attachThread({
      agentId: 'bot-a',
      childSessionKey: foreignTask,
      platform: 'slack',
      channel: 'C1',
      transportScope: elsewhere,
      thread: '8.1',
      sinceRound: 1,
      now: 1
    })
    await d.store.resolveAppendCoordinate('bot-a', 'C1', elsewhere, 1, 'coordinator')
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', foreignTask)).toBeUndefined()
    expect(await d.store.currentAppendCoordinate('bot-a', 'C1', elsewhere)).toBeUndefined()
    expect(await index.get('bot-a', keyAt('1.1'))).toBeDefined()
    expect(await coordinatorKey()).toBeDefined()
    await daemon.stop()
  })

  it('joins the task’s threads to the one session under Single session, and releases the task', async () => {
    const { daemon, d, calls, keyAt, route, setMode, index, at, coordinatorKey } = await withTask()
    setMode('append')
    await route(slack('5.2', { thread: '5.1', ...mention }))
    expect(isAppendCoordinate(calls[0]!.sessionThread)).toBe(true)
    expect(isCoordinatorCoordinate(calls[0]!.sessionThread)).toBe(false)
    // The append session replaced the coordinator's reservation already.
    expect(await coordinatorKey()).toBeUndefined()
    await d.leaveAutoConversations()
    expect(await index.get('bot-a', keyAt('1.1'))).toBeUndefined()
    expect(await index.taskOfThread('bot-a', at('1.1'))).toBeUndefined()
    await daemon.stop()
  })
})
