// The people's local time on every agent's turn (product-conventions.md "Local time"): the first zone of the sender's, the schedule's, the starter's, the place's, else UTC.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, CronDef } from '../src/agents/agent-schema.js'
import { Daemon } from '../src/daemon.js'
import { feishuUserProfile } from '../src/feishu/connection.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { ChannelNameResolver } from '../src/messages/channel-name-resolver.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { knownTimeZone, offsetTimeZone, profileTimeZone } from '../src/messages/time-zone.js'
import { buildSyntheticMessage } from '../src/scheduler/scheduler.js'
import { renderLocalNow } from '../src/session/local-time.js'
import { SessionManager } from '../src/session/session-manager.js'
import {
  checkCoordinate,
  researchCoordinate,
  subsessionCoordinate,
  taskCoordinate
} from '../src/session/subsession-coordinate.js'
import { SlackConnection } from '../src/slack/connection.js'
import { SlackNameResolver } from '../src/slack/name-resolver.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'
import { WAIT } from './wait-support.js'

// A Monday 04:20 in UTC+8 is still Sunday 20:20 in UTC.
const T = Date.parse('2026-10-11T20:20:00Z')
const HOUR = 3_600_000
const SCOPE = 'T0EXAMPLE'
const ON = { enabled: true }
const line = (text: string): string => `<system-reminder>\nNow: ${text}.\n</system-reminder>`
const SHANGHAI = line('2026-10-12 Mon 04:20 (Asia/Shanghai, UTC+08:00)')
const UTC = line('2026-10-11 Sun 20:20 (UTC, local time zone unknown)')
const LOS_ANGELES = line('2026-10-11 Sun 13:20 (America/Los_Angeles, UTC-07:00)')
const BERLIN = line('2026-10-11 Sun 22:20 (Europe/Berlin, UTC+02:00)')

describe('the local-time line', () => {
  it('names the local date, weekday, time, zone and offset, or UTC stated as unknown', () => {
    expect(renderLocalNow(T, 'Asia/Shanghai')).toBe(SHANGHAI)
    expect(renderLocalNow(T, 'America/Los_Angeles')).toBe(LOS_ANGELES)
    expect(renderLocalNow(T, '+05:30')).toBe(line('2026-10-12 Mon 01:50 (UTC+05:30)'))
    expect(renderLocalNow(T, undefined)).toBe(UTC)
    expect(renderLocalNow(T, 'Not/AZone')).toBe(UTC)
  })

  it('reads a zone from a name, else from a profile offset in seconds', () => {
    expect(knownTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(knownTimeZone('Not/AZone')).toBeUndefined()
    expect(knownTimeZone(28_800)).toBeUndefined()
    expect(knownTimeZone('x'.repeat(65))).toBeUndefined()
    expect(offsetTimeZone(19_800)).toBe('+05:30')
    expect(offsetTimeZone(-25_200)).toBe('-07:00')
    expect(offsetTimeZone(99 * HOUR)).toBeUndefined()
    expect(profileTimeZone('Asia/Kolkata', 19_800)).toBe('Asia/Kolkata')
    expect(profileTimeZone(undefined, 28_800)).toBe('+08:00')
    expect(profileTimeZone(null, undefined)).toBeUndefined()
  })
})

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const baseAgent = (assistantMode?: typeof ON): Agent & { dir: string; env: Record<string, string> } =>
  ({
    id: 'bot-a',
    name: 'bot-a',
    status: 'active',
    runtime: 'claude',
    dir: mkdtempSync(join(tmpdir(), 'ac-local-time-root-')),
    env: {},
    workspace: {
      mode: 'from-scratch',
      path: join(mkdtempSync(join(tmpdir(), 'ac-local-time-ws-')), 'ws'),
      gitBranch: 'main',
      pullOnNewSession: true,
      skills: []
    },
    integrations: [],
    output: { mode: 'medium' },
    permissions: { policy: 'ask', autoApprove: [] },
    crons: [],
    ...(assistantMode ? { assistantMode } : {})
  }) as unknown as Agent & { dir: string; env: Record<string, string> }

/** A person's message in a Slack DM, whose long conversation appends on one coordinate. */
const dm = (channel: string, user: string, ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  msgId: `slack:${channel}:${ts}`,
  traceId: ts,
  source: 'user',
  platform: 'slack',
  channel,
  thread: ts,
  sessionThread: 'append:1',
  transportScope: SCOPE,
  sender: { id: user, isBot: false },
  text: 'what day is it?',
  mentionedBots: [],
  isDm: true,
  ...over
})

/** A person's mention in a Slack channel. */
const room = (user: string, ts: string): NormalizedMessage =>
  dm('C0TEAM', user, ts, { isDm: false, trigger: 'mention' })

/** A turn the daemon started in a place on a background coordinate: a check, a task or a delegated sub-session. */
const background = (channel: string, thread: string, platform = 'slack'): NormalizedMessage => ({
  msgId: `${thread}:${channel}`,
  traceId: thread,
  transcriptTs: '1700000000900',
  source: 'agent',
  platform,
  channel,
  thread,
  ...(platform === 'slack' ? { transportScope: SCOPE } : {}),
  sender: { id: 'bot-a', isBot: true },
  text: 'check the item',
  mentionedBots: [],
  isDm: false,
  headless: true
})

/** A sub-session's report into the main conversation of a Slack DM. */
const report = (channel: string): NormalizedMessage => ({
  ...background(channel, '100.9'),
  sessionThread: 'append:1',
  headless: false,
  parentReport: true
})

/** A console turn in a webchat conversation, with the zone the author's browser reported. */
const webchat = (conversation: string, timeZone?: string): NormalizedMessage => ({
  msgId: `webchat:${conversation}`,
  traceId: `t-${conversation}`,
  source: 'user',
  platform: 'webchat',
  channel: conversation,
  sender: { id: 'usr_ada', isBot: false, name: 'ada' },
  ...(timeZone ? { senderTimeZone: timeZone } : {}),
  text: 'remind me this Friday',
  mentionedBots: [],
  isDm: true,
  trigger: 'dm'
})

/** A message in a Telegram group, whose profiles name no zone; a console continuation carries its browser's. */
const telegram = (sender: string, ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  msgId: `telegram:-1001:${ts}`,
  traceId: `tg-${ts}`,
  source: 'user',
  platform: 'telegram',
  channel: '-1001',
  thread: ts,
  sessionThread: 'append:1',
  transportScope: 'tg-example',
  sender: { id: sender, isBot: false },
  text: 'is the report due today?',
  mentionedBots: [],
  isDm: false,
  trigger: 'mention',
  ...over
})

/** A schedule configured in its own zone, posting into the team channel. */
const schedule = (over: Partial<CronDef> = {}): CronDef => ({
  id: 'cron-digest',
  schedule: '20 13 * * *',
  timezone: 'America/Los_Angeles',
  target: { platform: 'slack', channel: 'C0TEAM' },
  trigger: 'post the daily digest',
  enabled: true,
  origin: 'cp',
  ...over
})

/** A schedule's run as the scheduler builds it, on the team channel's bot. */
const scheduledRun = (cron: CronDef = schedule()): NormalizedMessage => ({
  ...buildSyntheticMessage('bot-a', cron, randomUUID(), new Date(T)).msg,
  transportScope: SCOPE
})

const localTimeOf = (blocks: { type: string; text?: string }[]): string[] =>
  blocks.flatMap((b) => (b.text?.includes('\nNow: ') ? [b.text] : []))

interface Sources {
  /** Profile zones by sender id. */
  profiles?: Record<string, string>
  /** Replaces the profile lookup outright. */
  profile?: (msg: NormalizedMessage) => Promise<string | undefined>
  /** The zone of whoever started a turn no person is behind, by session key. */
  startedBy?: (key: string) => Promise<string | undefined>
}

async function harness(assistantMode: typeof ON | undefined, sources: Sources = {}) {
  store = await openTestStore()
  const s = store
  const agent = baseAgent(assistantMode)
  const memory = createManagedMemoryProvider(() => localMemoryHome(new LocalMemoryFs(agent.dir)))
  const host = {
    newSession: vi.fn(async () => 'acp-1'),
    hasSession: () => true,
    usesMetaSystemPrompt: () => false
  } as any
  let now = T
  const senderTimeZoneFor = vi.fn(
    sources.profile ?? (async (msg: NormalizedMessage) => sources.profiles?.[msg.sender.id])
  )
  const startedByTimeZone = vi.fn(async (_agentId: string, key: string) => sources.startedBy?.(key))
  const notePersonTimeZone = vi.fn()
  const manager = () =>
    new SessionManager({
      store: s,
      hostFor: async () => host,
      agentById: () => agent,
      memory,
      senderTimeZoneFor,
      startedByTimeZone,
      notePersonTimeZone,
      now: () => now
    })
  return { s, manager, senderTimeZoneFor, startedByTimeZone, notePersonTimeZone, advance: (ms: number) => (now += ms) }
}

describe('the local-time line on every agent’s turns', () => {
  it('reaches an agent outside assistant mode on a Slack turn, in the sender’s profile zone', async () => {
    const { manager, senderTimeZoneFor, notePersonTimeZone, s } = await harness(undefined, {
      profiles: { U0ALICE: 'Asia/Shanghai' }
    })
    const turn = await manager().handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'), undefined, 'int-1')
    expect(localTimeOf(turn.blocks)).toEqual([SHANGHAI])
    expect(senderTimeZoneFor).toHaveBeenCalledWith(
      expect.objectContaining({ sender: { id: 'U0ALICE', isBot: false } }),
      'int-1'
    )
    // The sender's zone is kept for their place and as their own last known one.
    const key = sessionKey('slack', 'D0ALICE', 'append:1', 'bot-a', SCOPE)
    expect(notePersonTimeZone).toHaveBeenCalledWith(key, 'Asia/Shanghai')
    expect(await s.placeTimeZones.get('bot-a', { platform: 'slack', channel: 'D0ALICE', transportScope: SCOPE })).toBe(
      'Asia/Shanghai'
    )
  })

  it('reads a webchat turn in the browser’s zone, without a profile lookup', async () => {
    const { manager, senderTimeZoneFor } = await harness(undefined, { profiles: { usr_ada: 'Asia/Shanghai' } })
    const turn = await manager().handle('bot-a', webchat('conv-1', 'America/Los_Angeles'))
    expect(localTimeOf(turn.blocks)).toEqual([LOS_ANGELES])
    expect(senderTimeZoneFor).not.toHaveBeenCalled()
  })

  it('reads a scheduled run in its schedule’s own zone, even where the place last saw another', async () => {
    const { manager, startedByTimeZone } = await harness(undefined, {
      profiles: { U0ALICE: 'Asia/Shanghai' },
      startedBy: async () => 'Europe/Berlin'
    })
    const sm = manager()
    await sm.handle('bot-a', room('U0ALICE', '300.1'))
    expect(localTimeOf((await sm.handle('bot-a', scheduledRun())).blocks)).toEqual([LOS_ANGELES])
    expect(startedByTimeZone).not.toHaveBeenCalled()
    // A schedule's zone is not a person's, so the place keeps the one its people reported.
    expect(localTimeOf((await sm.handle('bot-a', background('C0TEAM', checkCoordinate('1')))).blocks)).toEqual([BERLIN])
    startedByTimeZone.mockResolvedValue(undefined)
    expect(localTimeOf((await sm.handle('bot-a', background('C0TEAM', checkCoordinate('2')))).blocks)).toEqual([
      SHANGHAI
    ])
    // A schedule on the host's clock names no zone of its own, and its run reads on down the order.
    const hostClock = scheduledRun(schedule({ id: 'cron-local', timezone: undefined }))
    expect(hostClock.scheduleTimeZone).toBeUndefined()
    expect(localTimeOf((await sm.handle('bot-a', hostClock)).blocks)).toEqual([SHANGHAI])
  })

  it('reads a check or a sub-session report in the zone of the person who started it', async () => {
    const reportKey = sessionKey('slack', 'D0ALICE', 'append:1', 'bot-a', SCOPE)
    const { manager, startedByTimeZone } = await harness(undefined, {
      profiles: { U0ALICE: 'Asia/Shanghai' },
      startedBy: async (key) => (key === reportKey ? 'Europe/Berlin' : 'America/Los_Angeles')
    })
    const sm = manager()
    await sm.handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'))
    expect(startedByTimeZone).not.toHaveBeenCalled()
    expect(localTimeOf((await sm.handle('bot-a', background('D0ALICE', checkCoordinate('1')))).blocks)).toEqual([
      LOS_ANGELES
    ])
    expect(localTimeOf((await sm.handle('bot-a', report('D0ALICE'))).blocks)).toEqual([BERLIN])
    expect(startedByTimeZone).toHaveBeenCalledWith('bot-a', reportKey)
  })

  it('falls back on Telegram to the place’s last seen zone, then UTC', async () => {
    const { manager, senderTimeZoneFor } = await harness(undefined)
    const sm = manager()
    expect(localTimeOf((await sm.handle('bot-a', telegram('1001', '1'))).blocks)).toEqual([UTC])
    // A console continuation into the group carries its browser's zone, which the place keeps.
    const continuation = telegram('usr_ada', '2', { senderTimeZone: 'Asia/Shanghai' })
    expect(localTimeOf((await sm.handle('bot-a', continuation)).blocks)).toEqual([SHANGHAI])
    expect(localTimeOf((await sm.handle('bot-a', telegram('1002', '3'))).blocks)).toEqual([SHANGHAI])
    expect(senderTimeZoneFor).toHaveBeenCalledTimes(2)
  })

  it('falls through a lookup that fails or hangs to the next source, never failing the turn', async () => {
    let startedBy = (): Promise<string | undefined> => Promise.reject(new Error('control plane unreachable'))
    const { manager, s } = await harness(undefined, {
      profile: async (msg) => {
        if (msg.sender.id === 'U0ALICE') return 'Asia/Shanghai'
        throw new Error('ratelimited')
      },
      startedBy: () => startedBy()
    })
    const sm = manager()
    await sm.handle('bot-a', room('U0ALICE', '300.1'))
    expect(localTimeOf((await sm.handle('bot-a', room('U0BOB', '300.2'))).blocks)).toEqual([SHANGHAI])
    expect(localTimeOf((await sm.handle('bot-a', background('C0TEAM', checkCoordinate('1')))).blocks)).toEqual([
      SHANGHAI
    ])
    startedBy = () => new Promise(() => {})
    expect(localTimeOf((await sm.handle('bot-a', background('C0TEAM', checkCoordinate('2')))).blocks)).toEqual([
      SHANGHAI
    ])
    vi.spyOn(s.placeTimeZones, 'get').mockRejectedValue(new Error('store unavailable'))
    vi.spyOn(s.placeTimeZones, 'note').mockRejectedValue(new Error('store unavailable'))
    expect(localTimeOf((await sm.handle('bot-a', room('U0BOB', '300.3'))).blocks)).toEqual([UTC])
    expect(localTimeOf((await sm.handle('bot-a', room('U0ALICE', '300.4'))).blocks)).toEqual([SHANGHAI])
  })
})

describe('the local-time line on an assistant-mode agent’s turns, unchanged', () => {
  it('gives a Slack DM turn the time in the sender’s profile zone, current at every turn', async () => {
    const { manager, advance, senderTimeZoneFor } = await harness(ON, { profiles: { U0ALICE: 'Asia/Shanghai' } })
    const sm = manager()
    expect(
      localTimeOf((await sm.handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'), undefined, 'int-1')).blocks)
    ).toEqual([SHANGHAI])
    expect(senderTimeZoneFor).toHaveBeenCalledWith(
      expect.objectContaining({ sender: { id: 'U0ALICE', isBot: false } }),
      'int-1'
    )
    advance(HOUR)
    expect(localTimeOf((await sm.handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.2'))).blocks)).toEqual([
      line('2026-10-12 Mon 05:20 (Asia/Shanghai, UTC+08:00)')
    ])
  })

  it('states UTC for a person whose profile names no zone', async () => {
    const { manager } = await harness(ON)
    const turn = await manager().handle('bot-a', dm('D0BOB', 'U0BOB', '200.1'))
    expect(localTimeOf(turn.blocks)).toEqual([UTC])
  })

  it('gives a webchat turn the zone its browser reported, without a profile lookup', async () => {
    const { manager, senderTimeZoneFor } = await harness(ON)
    const turn = await manager().handle('bot-a', webchat('conv-1', 'America/Los_Angeles'))
    expect(localTimeOf(turn.blocks)).toEqual([LOS_ANGELES])
    expect(senderTimeZoneFor).not.toHaveBeenCalled()
  })

  it('gives check, task, sub-session and report turns the zone last seen in their place, across a restart', async () => {
    const { manager } = await harness(ON, { profiles: { U0ALICE: 'Asia/Shanghai' } })
    await manager().handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'))
    await manager().handle('bot-a', webchat('conv-1', 'America/Los_Angeles'))

    const sm = manager()
    for (const thread of [checkCoordinate('1'), taskCoordinate('2'), subsessionCoordinate('3')])
      expect(localTimeOf((await sm.handle('bot-a', background('D0ALICE', thread))).blocks)).toEqual([SHANGHAI])
    expect(localTimeOf((await sm.handle('bot-a', report('D0ALICE'))).blocks)).toEqual([SHANGHAI])
    expect(
      localTimeOf((await sm.handle('bot-a', background('conv-1', subsessionCoordinate('4'), 'webchat'))).blocks)
    ).toEqual([LOS_ANGELES])
    // A place where no person reported a zone, and the same channel id under another workspace, read UTC.
    expect(localTimeOf((await sm.handle('bot-a', background('C0GENERAL', checkCoordinate('5')))).blocks)).toEqual([UTC])
    const elsewhere = { ...background('D0ALICE', checkCoordinate('6')), transportScope: 'T0OTHER' }
    expect(localTimeOf((await sm.handle('bot-a', elsewhere)).blocks)).toEqual([UTC])
  })

  it('keeps the place’s last seen zone for a later person whose profile names none', async () => {
    const { manager } = await harness(ON, { profiles: { U0ALICE: 'Asia/Shanghai' } })
    const sm = manager()
    await sm.handle('bot-a', room('U0ALICE', '300.1'))
    expect(localTimeOf((await sm.handle('bot-a', room('U0BOB', '300.2'))).blocks)).toEqual([SHANGHAI])
  })
})

describe('the organization research line (assistant-mode.md §5.15)', () => {
  const researchOf = (blocks: { type: string; text?: string }[]): string[] =>
    blocks.flatMap((b) => (b.text?.includes('Organization research is running') ? [b.text] : []))

  it('rides every place turn while research runs, beside the time and in its zone, and never a task’s', async () => {
    const { manager, s } = await harness(ON, { profiles: { U0ALICE: 'Asia/Shanghai' } })
    const sm = manager()
    expect(researchOf((await sm.handle('bot-a', room('U0ALICE', '400.1'))).blocks)).toEqual([])
    const taskKey = sessionKey('slack', 'D0ALICE', researchCoordinate('1'), 'bot-a', SCOPE)
    await s.assistantSubsessions.open({
      agentId: 'bot-a',
      childSessionKey: taskKey,
      parentSessionId: 'sid-dm',
      parentSessionKey: sessionKey('slack', 'D0ALICE', 'append:1', 'bot-a', SCOPE),
      now: T - HOUR
    })
    const turn = await sm.handle('bot-a', room('U0ALICE', '400.2'))
    expect(researchOf(turn.blocks)).toEqual([
      '<system-reminder>\nOrganization research is running since 03:20; what memory holds about the organization ' +
        'may be incomplete. Answer from what is known and say plainly that research is still running when it ' +
        'matters.\n</system-reminder>'
    ])
    // It sits right after the time.
    const texts = (turn.blocks as { text?: string }[]).map((b) => b.text ?? '')
    expect(texts[texts.findIndex((text) => text.includes('\nNow: ')) + 1]).toContain('Organization research is running')
    expect(researchOf((await sm.handle('bot-a', background('C0TEAM', checkCoordinate('1')))).blocks)).toEqual([])
    expect(researchOf((await sm.handle('bot-a', background('D0ALICE', researchCoordinate('1')))).blocks)).toEqual([])
    await s.assistantSubsessions.finish('bot-a', taskKey, 'done')
    expect(researchOf((await sm.handle('bot-a', room('U0ALICE', '400.3'))).blocks)).toEqual([])
  })
})

describe('a person’s profile zone', () => {
  const fakeConn = (profile: (user: string) => Promise<{ id: string; timeZone?: string }>) =>
    ({
      getUserProfile: vi.fn(profile),
      getChannelInfo: vi.fn(async (id: string) => ({ id }))
    }) as unknown as SlackConnection & {
      getUserProfile: ReturnType<typeof vi.fn>
    }

  it('reads the zone users.info reports, by name or else by offset', async () => {
    const users: Record<string, Record<string, unknown>> = {
      U0ALICE: { id: 'U0ALICE', tz: 'Asia/Shanghai', tz_offset: 28_800 },
      U0CAROL: { id: 'U0CAROL', tz_offset: 19_800 },
      U0BOB: { id: 'U0BOB' }
    }
    const factory = fakeSlackAppFactory()
    const conn = new SlackConnection(
      {
        group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
        onMessage: () => {},
        newTraceId: () => 't'
      } as never,
      ((opts: unknown) => {
        const app = factory(opts as never) as any
        app.client.users.info = async ({ user }: { user: string }) => ({ user: users[user] })
        return app
      }) as never
    )
    expect((await conn.getUserProfile('U0ALICE')).timeZone).toBe('Asia/Shanghai')
    expect((await conn.getUserProfile('U0CAROL')).timeZone).toBe('+05:30')
    expect(await conn.getUserProfile('U0BOB')).not.toHaveProperty('timeZone')
  })

  it('reads the zone a Feishu/Lark user record names, and none when it names none or an unknown one', () => {
    expect(feishuUserProfile('on_alice', { name: 'Alice', time_zone: 'Asia/Shanghai' })).toEqual({
      id: 'on_alice',
      name: 'Alice',
      timeZone: 'Asia/Shanghai'
    })
    expect(feishuUserProfile('on_bob', { name: 'Bob' })).toEqual({ id: 'on_bob', name: 'Bob' })
    expect(feishuUserProfile('on_carol', { name: 'Carol', time_zone: 'Not/AZone' })).toEqual({
      id: 'on_carol',
      name: 'Carol'
    })
    expect(feishuUserProfile('on_dan', undefined)).toEqual({ id: 'on_dan' })
  })

  it('waits for the lookup the message started, then answers from the cache', async () => {
    const conn = fakeConn(async (id) => ({ id, timeZone: 'Asia/Shanghai' }))
    const resolver = new SlackNameResolver(() => {})
    resolver.noteMessage(conn, { channel: 'D0ALICE', sender: { id: 'U0ALICE', isBot: false } })
    expect(await resolver.timeZoneOf(conn, 'U0ALICE')).toBe('Asia/Shanghai')
    expect(await resolver.timeZoneOf(conn, 'U0ALICE')).toBe('Asia/Shanghai')
    expect(conn.getUserProfile).toHaveBeenCalledTimes(1)
  })

  it('answers none for a profile without a zone, a bot id, a failed lookup or one that is too slow', async () => {
    const resolver = new SlackNameResolver(() => {})
    const none = fakeConn(async (id) => ({ id }))
    expect(await resolver.timeZoneOf(none, 'U0BOB')).toBeUndefined()
    expect(await resolver.timeZoneOf(none, 'B0BOT')).toBeUndefined()
    expect(none.getUserProfile).toHaveBeenCalledTimes(1)
    const failing = fakeConn(async () => {
      throw new Error('ratelimited')
    })
    expect(await resolver.timeZoneOf(failing, 'U0FAIL')).toBeUndefined()
    const slow = fakeConn(() => new Promise(() => {}))
    expect(await resolver.timeZoneOf(slow, 'U0SLOW', 5)).toBeUndefined()
  })

  it('on another platform, is read from the lookup a message started and never starts one', async () => {
    const resolver = new ChannelNameResolver(() => {})
    const named = fakeConn(async (id) => ({ id, timeZone: 'Asia/Shanghai' }))
    resolver.noteMessage(named, { channel: 'oc_team', sender: { id: 'on_alice', isBot: false } })
    expect(await resolver.timeZoneOf('on_alice')).toBe('Asia/Shanghai')
    // A sender who carries a name is not looked up, so a platform that keeps no zone costs no call.
    const unnamed = fakeConn(async (id) => ({ id }))
    resolver.noteMessage(unnamed, { channel: '-1001', sender: { id: '1001', isBot: false, name: 'Tom' } })
    expect(await resolver.timeZoneOf('1001')).toBeUndefined()
    expect(unnamed.getUserProfile).not.toHaveBeenCalled()
  })

  it('is what the daemon hands a turn on that integration, and nothing elsewhere', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.nameResolver = new SlackNameResolver(() => {})
    daemon.channelNameResolver = new ChannelNameResolver(() => {})
    daemon.connByIntegration.set(
      'int-1',
      fakeConn(async (id) => ({ id, timeZone: 'Asia/Shanghai' }))
    )
    const feishu = fakeConn(async (id) => ({ id, timeZone: 'Europe/Berlin' }))
    daemon.fsConnByIntegration.set('int-fs', feishu)
    const tg = fakeConn(async (id) => ({ id }))
    daemon.tgConnByIntegration.set('int-tg', tg)
    daemon.channelNameResolver.noteMessage(feishu, { channel: 'oc_team', sender: { id: 'on_alice', isBot: false } })
    expect(await daemon.profileTimeZone('int-1', 'U0ALICE')).toBe('Asia/Shanghai')
    expect(await daemon.profileTimeZone('int-fs', 'on_alice')).toBe('Europe/Berlin')
    expect(await daemon.profileTimeZone('int-tg', '1001')).toBeUndefined()
    expect(tg.getUserProfile).not.toHaveBeenCalled()
    expect(await daemon.profileTimeZone('int-2', 'U0ALICE')).toBeUndefined()
    expect(await daemon.profileTimeZone(undefined, 'U0ALICE')).toBeUndefined()
  })
})

const AGENT = 'bot-a'
const INT = 'int-bot-a'
const ALICE = { kind: 'member', platform: 'slack', integrationId: INT, userId: 'U0ALICE' } as const
const ADA = { kind: 'console', userId: 'usr_ada' } as const

/** A daemon serving one Slack integration for an agent outside assistant mode, whose turns hang until released. */
async function liveDaemon(zones: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ac-local-time-daemon-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: { bindRules: [{ match: { kind: 'mention' } }], sessionModes: [{ channel: 'D0ALICE', mode: 'append' }] },
          config: { botToken: 'xoxb-test', appToken: 'xapp-test' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  const releases: (() => void)[] = []
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${randomUUID()}`),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (_sessionId: string, _blocks: { type: string; text?: string }[]) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return 'end_turn'
    }),
    cancel: vi.fn(async () => releases.shift()?.()),
    stop: vi.fn(async () => {})
  }
  const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root, hostFactory: () => host as any })
  await daemon.start()
  const d = daemon as any
  d.nameResolver = { noteMessage: () => {}, timeZoneOf: async (_conn: unknown, user: string) => zones[user] }
  const placement = { agentId: AGENT, daemonId: 'local-daemon', name: AGENT }
  d.cpCollab.replace({
    generation: 0,
    channels: [{ orgId: 'org-a', platform: 'slack', channelId: 'D0ALICE', agents: [placement] }],
    agents: [{ ...placement, orgId: 'org-a' }]
  })
  const scope: string = d.transportScopeForIntegrationIds([INT])
  const stop = async (): Promise<void> => {
    releases.splice(0).forEach((release) => release())
    await daemon.stop()
    rmSync(root, { recursive: true, force: true })
  }
  return { d, host, scope, stop }
}

describe('a daemon’s turns', () => {
  it('tell an agent outside assistant mode the sender’s local time, and keep it out of the transcript', async () => {
    const { d, host, scope, stop } = await liveDaemon({ U0ALICE: 'Asia/Shanghai' })
    try {
      const coordinate: string = await d.store.resolveAppendCoordinate(AGENT, 'D0ALICE', scope, 1)
      const msg: NormalizedMessage = {
        ...dm('D0ALICE', 'U0ALICE', '1700000000.000101', { sessionThread: coordinate, transportScope: scope }),
        traceId: randomUUID(),
        text: 'is the release today?'
      }
      void d.dispatch(AGENT, msg, INT)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(1), WAIT)
      const blocks = host.prompt.mock.calls[0]![1]
      expect(localTimeOf(blocks)).toEqual([
        expect.stringMatching(
          /^<system-reminder>\nNow: \d{4}-\d\d-\d\d \w{3} \d\d:\d\d \(Asia\/Shanghai, UTC\+08:00\)\.\n/
        )
      ])
      const rows: { text: string }[] = await d.store.threadTranscript(
        transcriptChannelKey('D0ALICE', scope),
        msg.thread
      )
      expect(rows.map((row) => row.text)).toContain('is the release today?')
      expect(rows.some((row) => row.text.includes('Now:'))).toBe(false)
      // The sender is remembered as a person, for a run they start later.
      expect(d.personTimeZones.get(ALICE)).toBe('Asia/Shanghai')
    } finally {
      await stop()
    }
  })

  it('read a follow-up’s check as its asker and a sub-session report as its opener, through their linked account or last known zone', async () => {
    const { d, scope, stop } = await liveDaemon({ U0ALICE: 'Asia/Shanghai', U0BOB: 'Europe/Berlin' })
    const keys: string[] = []
    const live = (thread: string, entry: Record<string, unknown>): string => {
      const key = sessionKey('slack', 'D0ALICE', thread, AGENT, scope)
      d.activeGateEntries.set(key, entry)
      keys.push(key)
      return key
    }
    try {
      // A follow-up's check reads as the person who confirmed it, in their profile's zone.
      const tenant = await d.tenantScopeForIntegration(d.integrationConfigById(INT))
      const origin = { platform: 'slack', channel: 'D0ALICE', transportScope: scope }
      await d.store.assistantItems.create({
        agentId: AGENT,
        title: 'ship the release notes',
        origin,
        taskKey: sessionKey('slack', 'D0ALICE', checkCoordinate('r1'), AGENT, scope),
        asker: `slack:${tenant}:U0ALICE`
      })
      const check = live(checkCoordinate('r1'), {
        msg: background('D0ALICE', checkCoordinate('r1')),
        integrationId: INT
      })
      expect(await d.startedByTimeZone(AGENT, check)).toBe('Asia/Shanghai')

      // A report reads as whoever opened the sub-session it came from: a console user, in their browser's last zone.
      const childKey = sessionKey('slack', 'D0ALICE', subsessionCoordinate('c1'), AGENT, scope)
      await d.store.upsertSession({
        key: childKey,
        agentId: AGENT,
        platform: 'slack',
        channel: 'D0ALICE',
        thread: subsessionCoordinate('c1'),
        transportScope: scope,
        acpSessionId: 'acp-child',
        sessionId: 'sess-child',
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: T
      })
      d.subsessionOpeners.set(childKey, { people: [ADA], nobody: false })
      const parent = live('append:1', {
        msg: report('D0ALICE'),
        integrationId: INT,
        callMeta: { callFrom: AGENT, hopCount: 1, deliveryId: 'd-1', originSessionId: 'sess-child' }
      })
      expect(await d.startedByTimeZone(AGENT, parent)).toBeUndefined()
      const webchatKey = live('conv-ada', { msg: webchat('conv-ada'), webchat: { initiator: 'user' } })
      d.notePersonTimeZone(webchatKey, 'America/Los_Angeles')
      expect(await d.startedByTimeZone(AGENT, parent)).toBe('America/Los_Angeles')

      // Without a last known zone, the chat account the console user linked on the agent's bot answers.
      d.personTimeZones = new d.personTimeZones.constructor()
      const linked = vi.spyOn(d.placeMembers, 'linkedMember').mockResolvedValue('U0BOB')
      expect(await d.startedByTimeZone(AGENT, parent)).toBe('Europe/Berlin')
      expect(linked).toHaveBeenCalledWith(AGENT, INT, ADA)
      // A link that cannot be read falls through, and the turn reads on down the order.
      linked.mockRejectedValue(new Error('control plane unreachable'))
      expect(await d.startedByTimeZone(AGENT, parent)).toBeUndefined()
    } finally {
      // The stand-in live entries are not turns, so shutdown must not try to cancel them.
      for (const key of keys) d.activeGateEntries.delete(key)
      await stop()
    }
  })
})
