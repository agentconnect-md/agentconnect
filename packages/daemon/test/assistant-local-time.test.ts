// The people's local time on assistant-mode turns (assistant-mode.md §5.4): the sender's zone, else the place's last seen, else UTC.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderLocalNow } from '../src/assistant/local-time.js'
import type { Agent } from '../src/agents/agent-schema.js'
import { Daemon } from '../src/daemon.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { knownTimeZone, offsetTimeZone, profileTimeZone } from '../src/messages/time-zone.js'
import { SessionManager } from '../src/session/session-manager.js'
import { patrolCoordinate, subsessionCoordinate, taskCoordinate } from '../src/session/subsession-coordinate.js'
import { SlackConnection } from '../src/slack/connection.js'
import { SlackNameResolver } from '../src/slack/name-resolver.js'
import type { LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'

// A Monday 04:20 in UTC+8 is still Sunday 20:20 in UTC.
const T = Date.parse('2026-10-11T20:20:00Z')
const HOUR = 3_600_000
const SCOPE = 'T0EXAMPLE'
const ON = { enabled: true }
const line = (text: string): string => `<system-reminder>\nNow: ${text}.\n</system-reminder>`
const SHANGHAI = line('2026-10-12 Mon 04:20 (Asia/Shanghai, UTC+08:00)')
const UTC = line('2026-10-11 Sun 20:20 (UTC, local time zone unknown)')
const LOS_ANGELES = line('2026-10-11 Sun 13:20 (America/Los_Angeles, UTC-07:00)')

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

/** A turn the daemon started in a place on a background coordinate: a patrol, a task or a delegated sub-session. */
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

const localTimeOf = (blocks: { type: string; text?: string }[]): string[] =>
  blocks.flatMap((b) => (b.text?.includes('\nNow: ') ? [b.text] : []))

async function harness(assistantMode: typeof ON | undefined, profileZones: Record<string, string> = {}) {
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
  const senderTimeZoneFor = vi.fn(async (msg: NormalizedMessage) => profileZones[msg.sender.id])
  const manager = () =>
    new SessionManager({
      store: s,
      hostFor: async () => host,
      agentById: () => agent,
      memory,
      senderTimeZoneFor,
      now: () => now
    })
  return { s, manager, senderTimeZoneFor, advance: (ms: number) => (now += ms) }
}

describe('the local-time line on assistant-mode turns', () => {
  it('gives a Slack DM turn the time in the sender’s profile zone, current at every turn', async () => {
    const { manager, advance, senderTimeZoneFor } = await harness(ON, { U0ALICE: 'Asia/Shanghai' })
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

  it('gives patrol, task, sub-session and report turns the zone last seen in their place, across a restart', async () => {
    const { manager } = await harness(ON, { U0ALICE: 'Asia/Shanghai' })
    await manager().handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'))
    await manager().handle('bot-a', webchat('conv-1', 'America/Los_Angeles'))

    const sm = manager()
    for (const thread of [patrolCoordinate('1'), taskCoordinate('2'), subsessionCoordinate('3')])
      expect(localTimeOf((await sm.handle('bot-a', background('D0ALICE', thread))).blocks)).toEqual([SHANGHAI])
    const report: NormalizedMessage = {
      ...background('D0ALICE', '100.9'),
      sessionThread: 'append:1',
      headless: false,
      parentReport: true
    }
    expect(localTimeOf((await sm.handle('bot-a', report)).blocks)).toEqual([SHANGHAI])
    expect(
      localTimeOf((await sm.handle('bot-a', background('conv-1', subsessionCoordinate('4'), 'webchat'))).blocks)
    ).toEqual([LOS_ANGELES])
    // A place where no person reported a zone, and the same channel id under another workspace, read UTC.
    expect(localTimeOf((await sm.handle('bot-a', background('C0GENERAL', patrolCoordinate('5')))).blocks)).toEqual([
      UTC
    ])
    const elsewhere = { ...background('D0ALICE', patrolCoordinate('6')), transportScope: 'T0OTHER' }
    expect(localTimeOf((await sm.handle('bot-a', elsewhere)).blocks)).toEqual([UTC])
  })

  it('keeps the place’s last seen zone for a later person whose profile names none', async () => {
    const { manager } = await harness(ON, { U0ALICE: 'Asia/Shanghai' })
    const sm = manager()
    const channel = (user: string, ts: string) => dm('C0TEAM', user, ts, { isDm: false, trigger: 'mention' })
    await sm.handle('bot-a', channel('U0ALICE', '300.1'))
    expect(localTimeOf((await sm.handle('bot-a', channel('U0BOB', '300.2'))).blocks)).toEqual([SHANGHAI])
  })

  it('never appears for an agent outside assistant mode', async () => {
    const { manager, s, senderTimeZoneFor } = await harness(undefined, { U0ALICE: 'Asia/Shanghai' })
    const sm = manager()
    expect(localTimeOf((await sm.handle('bot-a', dm('D0ALICE', 'U0ALICE', '100.1'))).blocks)).toEqual([])
    expect(localTimeOf((await sm.handle('bot-a', webchat('conv-1', 'Asia/Shanghai'))).blocks)).toEqual([])
    expect(senderTimeZoneFor).not.toHaveBeenCalled()
    expect(
      await s.assistantTimeZones.get('bot-a', { platform: 'webchat', channel: 'conv-1', transportScope: null })
    ).toBeUndefined()
  })
})

describe('a Slack sender’s profile zone', () => {
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

  it('is what the daemon hands a turn on that Slack integration, and nothing elsewhere', async () => {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.nameResolver = new SlackNameResolver(() => {})
    daemon.connByIntegration.set(
      'int-1',
      fakeConn(async (id) => ({ id, timeZone: 'Asia/Shanghai' }))
    )
    const msg = dm('D0ALICE', 'U0ALICE', '100.1')
    expect(await daemon.senderProfileTimeZone(msg, 'int-1')).toBe('Asia/Shanghai')
    expect(await daemon.senderProfileTimeZone(msg, 'int-2')).toBeUndefined()
    expect(await daemon.senderProfileTimeZone(msg, undefined)).toBeUndefined()
  })
})
