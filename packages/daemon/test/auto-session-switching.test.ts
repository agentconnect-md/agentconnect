// auto-session-mode.md §3.3, §3.5: Any message under auto, and switching a conversation into and out of it.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { normalizeQQMessage } from '@agentconnect.md/message'
import { manifestFor } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { WeComConnection } from '../src/platforms/wecom/connection.js'
import {
  deliveredMessage,
  earlierRoomSessionAnchor,
  THREADED_TASK_IDLE_CLOSE_MS
} from '../src/auto-session/coordinator-sessions.js'
import { coordinatorSessionTools } from '../src/auto-session/coordinator-prompt.js'
import {
  atThreadlessRoot,
  inThread,
  replyThreadOf,
  threadlessRoom,
  wholeRoomThread
} from '../src/auto-session/coordinator-turns.js'
import { WECOM_DM_THREAD, WECOM_GROUP_THREAD } from '../src/platforms/wecom/module.js'
import { THREADLESS_NEW_TASKS_NOTE, THREADLESS_STOP_TASKS_NOTE } from '../src/commands/handlers.js'
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

// The conversation each platform's harness runs in: Slack threads off a message, WeCom and QQ key a group as one thread.
const ROOMS = {
  slack: { channel: 'C1', config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' } },
  wecom: { channel: 'chat-example-group', config: { botId: 'aibot-example', secret: 'secret-placeholder' } },
  qq: { channel: 'group:chat-example-group', config: { appId: '100', appSecret: 'secret-placeholder' } }
} as const
type Platform = keyof typeof ROOMS

function scaffold(mode: Mode, platform: Platform = 'slack'): string {
  const room = ROOMS[platform]
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
          platform,
          // Mention only: under auto the daemon admits Any message itself (§3.3).
          core: {
            bindRules: [{ match: { kind: 'mention' } }],
            sessionModes: mode === 'createNew' ? [] : [{ channel: room.channel, mode }]
          },
          config: room.config
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(mode: Mode, platform: Platform = 'slack') {
  const { channel } = ROOMS[platform]
  vi.spyOn(WeComConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
  const clock = new FakeClock(Date.now())
  const daemon = new Daemon({
    root: scaffold(mode, platform),
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
  const keyAt = (thread: string, at: string = channel) => sessionKey(platform, at, thread, 'bot-a', scope)
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  // Mode is read per message (channel-session-mode.md §3.4), so the switch is the live spec's.
  const setMode = (next: Mode) => {
    d.agents.get('bot-a').integrations[0].core.sessionModes = next === 'createNew' ? [] : [{ channel, mode: next }]
  }
  const seed = async (thread: string, over: Partial<SessionRecord> = {}) => {
    const { title, ...row } = over
    await d.store.upsertSession({
      key: keyAt(thread, over.channel),
      agentId: 'bot-a',
      platform,
      channel,
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
    const coordinate = await d.store.currentAppendCoordinate('bot-a', channel, scope, 'coordinator')
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
  const at = (thread: string) => ({ platform, channel, transportScope: scope, thread })
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
    // §6.2: released, its metadata names no owner, so its visibility is its sender's again; queued durably.
    expect(emit.mock.calls.map(([snapshot]: any[]) => [snapshot.sessionKey, snapshot.ordered])).toEqual([
      [keyAt('1.1'), true]
    ])
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

// auto-session-mode.md §3.6: an agent whose coordinator is off runs its `auto` rows as Single session until it is back on.
describe('turning the coordinator off', () => {
  it('keys an Auto row on one session, retires the coordinator, and restores Auto once it is on again', async () => {
    const { daemon, d, calls, scope, route, coordinatorKey } = await boot('auto')
    await route(slack('1.1'))
    expect(await coordinatorKey()).toBeDefined()
    calls.length = 0

    d.agents.get('bot-a').coordinatorDisabled = true
    await d.leaveAutoConversations()
    expect(await coordinatorKey()).toBeUndefined()
    // The row's own trigger holds again: a mention joins the conversation's one session, an unaddressed root nothing.
    await route(slack('2.1', mention))
    await route(slack('2.2', { thread: '2.1', ...mention }))
    await route(slack('2.3'))
    const append = await d.store.currentAppendCoordinate('bot-a', 'C1', scope)
    expect(append).toBeDefined()
    expect(isAppendCoordinate(append)).toBe(true)
    expect(isCoordinatorCoordinate(append)).toBe(false)
    expect(calls.map((msg) => msg.sessionThread)).toEqual([append, append])

    calls.length = 0
    delete d.agents.get('bot-a').coordinatorDisabled
    await route(slack('3.1'))
    expect(calls.map((msg) => isCoordinatorCoordinate(msg.sessionThread))).toEqual([true])
    await daemon.stop()
  })
})

// A mention in a WeCom group, before canonicalization gives it the group's root key.
const weComGroup = (id: string, text = '@bot what changed today?'): NormalizedMessage =>
  ({
    msgId: `wecom:aibot-example:${id}`,
    traceId: `t-${id}`,
    source: 'user',
    platform: 'wecom',
    channel: ROOMS.wecom.channel,
    sender: { id: 'user-alice', isBot: false },
    text,
    mentionedBots: ['aibot-example'],
    isDm: false
  }) as NormalizedMessage

const qqGroup = (id: string, text = 'what changed today?'): NormalizedMessage =>
  normalizeQQMessage(
    '100',
    {
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      kind: 'group',
      groupOpenid: 'chat-example-group',
      senderId: 'user-alice',
      messageId: id,
      content: `<@!100> ${text}`
    },
    `t-${id}`
  ) as NormalizedMessage

// auto-session-mode.md §6.10: a room its platform gives no threads keeps every message at its root.
describe('a room without threads', () => {
  it('is declared by the platform: its fixed key names the root, and a message’s own id anchors its thread', () => {
    expect(manifestFor('wecom').threadlessRoomRoot).toBe(WECOM_GROUP_THREAD)
    expect(qqGroup('m0').thread).toBe(manifestFor('qq').threadlessRoomRoot)
    for (const [platform, msgId, channel] of [
      ['wecom', 'wecom:aibot-example:m1', 'chat-example-group'],
      ['qq', 'qq:100:group:chat-example-group:m1', 'group:chat-example-group']
    ] as const) {
      const root = { platform, msgId, channel, thread: 'group', isDm: false }
      expect(atThreadlessRoot(root)).toBe(true)
      expect(inThread(root)).toBe(false)
      expect(replyThreadOf(root)).toBe('m1')
      expect(threadlessRoom(root)).toBe(true)
      // §6.8 stays its own shape: such a group is not a room keyed by its own id.
      expect(wholeRoomThread(root)).toBe(false)
      // A direct chat is one session too, and no room: its own mode decides.
      const dm = { platform, msgId, channel: 'dm:user-alice', thread: 'dm', isDm: true }
      expect(atThreadlessRoot(dm)).toBe(false)
      expect(threadlessRoom(dm)).toBe(false)
      expect(atThreadlessRoot({ ...dm, thread: 'group' })).toBe(false)
    }
    expect(threadlessRoom({ platform: 'wecom', channel: 'dm:user-alice' })).toBe(false)
    expect(atThreadlessRoot({ platform: 'wecom', thread: WECOM_DM_THREAD })).toBe(false)
    // Elsewhere the same key is an ordinary thread, and a root's thread its own id, as before.
    const slackRoot = { platform: 'slack', msgId: 'slack:C1:1.1', thread: '1.1' }
    expect(atThreadlessRoot({ ...slackRoot, thread: 'group' })).toBe(false)
    expect(inThread({ ...slackRoot, thread: 'group' })).toBe(true)
    expect(replyThreadOf({ ...slackRoot, thread: 'group' })).toBe('group')
    expect(inThread(slackRoot)).toBe(false)
    expect(threadlessRoom({ platform: 'slack', channel: 'C1' })).toBe(false)
    expect(wholeRoomThread({ channel: 'C1', thread: 'C1' })).toBe(true)
  })

  for (const [platform, message] of [
    ['wecom', weComGroup],
    ['qq', qqGroup]
  ] as const) {
    describe(`a ${platform} group`, () => {
      it('brings every message to the coordinator when the group starts in auto, and no task holds its root', async () => {
        const { daemon, d, calls, scope, index, route, coordinatorKey, at } = await boot('auto', platform)
        await route(message('m1'))
        await route(message('m2'))
        const coordinate = await d.store.currentAppendCoordinate('bot-a', ROOMS[platform].channel, scope, 'coordinator')
        expect(isCoordinatorCoordinate(coordinate)).toBe(true)
        expect(calls.map((msg) => [msg.thread, msg.sessionThread])).toEqual([
          ['group', coordinate],
          ['group', coordinate]
        ])
        expect(await coordinatorKey()).toBeDefined()
        expect(await index.taskOfThread('bot-a', at('group'))).toBeUndefined()
        await daemon.stop()
      })

      it('makes the room’s session a task on an anchor of its own on the switch into auto', async () => {
        const { daemon, d, calls, index, keyAt, route, setMode, seed, coordinatorKey, tasksOf, at } = await boot(
          'createNew',
          platform
        )
        // Per thread: the group is one session, keyed by its root key.
        await route(message('m1'))
        expect(calls.map((msg) => [msg.thread, msg.sessionThread])).toEqual([['group', undefined]])
        await seed('group', { title: 'Meet the team', lastDeliveredTs: 'm1' })
        setMode('auto')
        const owners = vi.spyOn(d, 'reportTaskOwners')

        await route(message('m2'))
        const parent = (await coordinatorKey())!
        expect(isCoordinatorCoordinate(calls[1]!.sessionThread)).toBe(true)
        expect(keyAt(calls[1]!.sessionThread!)).toBe(parent)
        // The old session is the coordinator's task, reachable by its id, but it holds no key a message carries.
        expect((await tasksOf(parent)).map((row) => [row.childSessionKey, row.title, row.state])).toEqual([
          [keyAt('group'), 'Meet the team', 'done']
        ])
        expect(owners).toHaveBeenCalledWith('bot-a', [keyAt('group')])
        expect(await index.taskOfThread('bot-a', at('group'))).toBeUndefined()
        expect((await index.threadsOf('bot-a', keyAt('group'))).map((one: { thread: string }) => one.thread)).toEqual([
          earlierRoomSessionAnchor('group')
        ])
        expect(await index.taskOfThread('bot-a', at('m1'))).toBeUndefined()

        // A later message also reaches the coordinator, which hands it to the old session as one of its tasks.
        await route(message('m3'))
        expect(calls[2]!.sessionThread).toBe(calls[1]!.sessionThread)
        const handed = await handOver(d, calls, calls[2]!, keyAt('group'))
        expect(handed).toMatchObject({ thread: 'm3', sessionThread: 'group' })
        expect(await index.taskOfThread('bot-a', at('m3'))).toBe(keyAt('group'))
        await daemon.stop()
      })

      it('adopts the room’s session whatever its replay cursor, never as holding the room’s root', async () => {
        const { daemon, d, scope, index, keyAt, seed, at } = await boot('auto', platform)
        // A recreated runtime session resets the cursor; the session has still answered the room before.
        await seed('group', { title: 'Meet the team' })
        const room = { platform, channel: ROOMS[platform].channel, transportScope: scope }
        expect(await d.coordinators.adoptThreadSessions('bot-a', keyAt('append:coordinator-1'), room)).toBe(1)
        expect(await index.get('bot-a', keyAt('group'))).toBeDefined()
        expect(await index.taskOfThread('bot-a', at(earlierRoomSessionAnchor('group')))).toBe(keyAt('group'))
        expect(await index.taskOfThread('bot-a', at('group'))).toBeUndefined()
        // The anchor is no message's thread: a message keyed on it would sit in a thread, which none here does.
        const anchored = { platform, msgId: `${platform}:example:m9`, thread: earlierRoomSessionAnchor('group') }
        expect(atThreadlessRoot(anchored)).toBe(false)
        expect(replyThreadOf({ ...anchored, thread: 'group' })).not.toBe(earlierRoomSessionAnchor('group'))
        await daemon.stop()
      })

      it('makes the coordinator real on the next message after the bug’s rows, the old session one of its tasks', async () => {
        const { daemon, d, calls, scope, index, keyAt, route, seed, tasksOf, at } = await boot('auto', platform)
        // What the bug wrote: a reserved coordinator with an outward id and no session, and the group's session as its task holding the root.
        await seed('group', { title: 'Meet the team', lastDeliveredTs: 'm1' })
        const reserved: string = await d.store.resolveAppendCoordinate(
          'bot-a',
          ROOMS[platform].channel,
          scope,
          1,
          'coordinator'
        )
        const parent = keyAt(reserved)
        await index.adoptThreadSession({
          agentId: 'bot-a',
          childSessionKey: keyAt('group'),
          parentSessionId: await d.store.ensureOutwardSessionId(parent, 'bot-a', 1),
          parentSessionKey: parent,
          title: 'Meet the team',
          ...at('group'),
          running: false,
          now: 1
        })
        expect(await d.store.getSession(parent)).toBeUndefined()

        await route(message('m2'))
        // The message keys on the reserved coordinator, whose session its dispatch now opens.
        expect(calls.map((msg) => [msg.thread, msg.sessionThread])).toEqual([['group', reserved]])
        expect((await tasksOf(parent)).map((row) => row.childSessionKey)).toEqual([keyAt('group')])
        const handed = await handOver(d, calls, calls[0]!, keyAt('group'))
        expect(handed).toMatchObject({ thread: 'm2', sessionThread: 'group' })
        await daemon.stop()
      })

      it('returns the room to its one session on the switch back out of auto', async () => {
        const { daemon, d, calls, index, keyAt, route, setMode, seed, coordinatorKey, at } = await boot(
          'createNew',
          platform
        )
        await seed('group', { lastDeliveredTs: 'm1' })
        setMode('auto')
        await route(message('m2'))
        expect(await index.get('bot-a', keyAt('group'))).toBeDefined()
        setMode('createNew')
        await d.leaveAutoConversations()
        expect(await coordinatorKey()).toBeUndefined()
        expect(await index.get('bot-a', keyAt('group'))).toBeUndefined()
        expect(await index.taskOfThread('bot-a', at(earlierRoomSessionAnchor('group')))).toBeUndefined()
        await route(message('m3'))
        expect(calls.at(-1)).toMatchObject({ thread: 'group' })
        expect(calls.at(-1)!.sessionThread).toBeUndefined()
        // Back into auto, a new coordinator adopts the same session on the same anchor again.
        setMode('auto')
        await route(message('m4'))
        expect(await index.taskOfThread('bot-a', at(earlierRoomSessionAnchor('group')))).toBe(keyAt('group'))
        await daemon.stop()
      })

      it('keeps one session in Per thread and in Single session, as before', async () => {
        const perThread = await boot('createNew', platform)
        await perThread.route(message('m1'))
        await perThread.route(message('m2'))
        expect(perThread.calls.map((msg) => [msg.thread, msg.sessionThread])).toEqual([
          ['group', undefined],
          ['group', undefined]
        ])
        expect(await perThread.coordinatorKey()).toBeUndefined()
        await perThread.daemon.stop()

        const single = await boot('append', platform)
        await single.route(message('m1'))
        await single.route(message('m2'))
        const append = single.calls[0]!.sessionThread
        expect(isAppendCoordinate(append)).toBe(true)
        expect(isCoordinatorCoordinate(append)).toBe(false)
        expect(single.calls.map((msg) => msg.sessionThread)).toEqual([append, append])
        await single.daemon.stop()
      })

      it('answers !stop and !new without sending anyone to a thread the room does not have', async () => {
        const { daemon, d, calls, route, seed } = await boot('auto', platform)
        const replies: string[] = []
        const chrome = vi
          .spyOn(d.commandChrome.for(platform), 'reply')
          .mockImplementation((_conn, _msg, _ctx, text) => void replies.push(text as string))
        const command = (id: string, text: string) => {
          const msg = message(id, text)
          if (platform === 'wecom') msg.text = text
          return msg
        }
        await route(message('m1'))
        await seed(calls[0]!.sessionThread!)
        await route(command('m2', '!stop'))
        await route(command('m3', '!new'))
        expect(replies).toEqual([
          `Nothing is running. ${THREADLESS_STOP_TASKS_NOTE}`,
          `🆕 Started a new session for new messages here. ${THREADLESS_NEW_TASKS_NOTE}`
        ])
        chrome.mockRestore()
        await daemon.stop()

        // Per thread keeps the room on one session, which the replies call the conversation.
        const perThread = await boot('createNew', platform)
        const said: string[] = []
        const again = vi
          .spyOn(perThread.d.commandChrome.for(platform), 'reply')
          .mockImplementation((_conn, _msg, _ctx, text) => void said.push(text as string))
        await perThread.seed('group')
        await perThread.route(command('m4', '!stop'))
        await perThread.route(command('m5', '!new'))
        expect(said).toEqual([
          '🔇 Nothing is running. Muted in this conversation — @mention me to resume.',
          '🆕 Cleared. This conversation continues with a fresh context.'
        ])
        again.mockRestore()
        await perThread.daemon.stop()
      })

      it('acts on no earlier session for a command at the root before the coordinator exists', async () => {
        const { daemon, d, keyAt, route, setMode, seed } = await boot('createNew', platform)
        await seed('group', { lastDeliveredTs: 'm1' })
        setMode('auto')
        const command = message('m2', '!new')
        if (platform === 'wecom') command.text = '!new'
        await route(command)
        // The room's earlier session keeps its context: the command found nothing to clear.
        expect((await d.store.getSession(keyAt('group')))?.acpSessionId).toBe('acp-group')
        await daemon.stop()
      })
    })
  }

  it('keeps a Slack conversation’s routing: the root to the coordinator, a thread a task holds to the task', async () => {
    const { daemon, calls, keyAt, index, route, setMode, seed, coordinatorKey, tasksOf, at } = await boot('createNew')
    await seed('1.1', { title: 'A thread from before' })
    await seed('C1', { title: 'Keyed on the room' })
    setMode('auto')
    await route(slack('9.1'))
    const parent = (await coordinatorKey())!
    expect(keyAt(calls[0]!.sessionThread!)).toBe(parent)
    // A session keyed on the room itself is never adopted (§6.8); a thread session is, holding its own thread.
    expect((await tasksOf(parent)).map((row) => row.childSessionKey)).toEqual([keyAt('1.1')])
    expect(await index.taskOfThread('bot-a', at('1.1'))).toBe(keyAt('1.1'))
    await route(slack('1.5', { thread: '1.1' }))
    expect(calls[1]).toMatchObject({ thread: '1.1' })
    expect(calls[1]!.sessionThread).toBeUndefined()
    await route(slack('9.2', { thread: 'group' }))
    expect(keyAt(calls[2]!.sessionThread!)).toBe(parent)
    await daemon.stop()
  })
})

/** The coordinator hands a message routed to it to `taskKey` in a turn of its own, as its messageTask call does (§5.1); what the task receives. */
async function handOver(d: any, calls: NormalizedMessage[], routed: NormalizedMessage, taskKey: string) {
  const coordinate = routed.sessionThread!
  const key = sessionKey(routed.platform, routed.channel, coordinate, 'bot-a', routed.transportScope)
  const delivered = deliveredMessage({ ...routed, headless: true }, 'int-bot-a')
  d.coordinators.turns.begin(key, [delivered])
  const ctx = {
    agentId: 'bot-a',
    platform: routed.platform,
    channel: routed.channel,
    thread: coordinate,
    transportScope: routed.transportScope,
    isDm: false,
    tools: coordinatorSessionTools([])
  }
  const before = calls.length
  await d.coordinators.decide(ctx, { action: 'messageTask', messageId: delivered.id, taskId: taskKey })
  d.coordinators.turns.end(key)
  await vi.waitFor(() => expect(calls.length).toBe(before + 1))
  return calls.at(-1)!
}
