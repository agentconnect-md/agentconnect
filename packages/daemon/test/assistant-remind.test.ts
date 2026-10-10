// Assistant-mode reminders (assistant-mode.md §5.9): text posted into the conversation it was set in, at its time, by the daemon, with no model turn.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantReminders, type AssistantRemindersHost } from '../src/assistant/reminders.js'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { ASSISTANT_ITEM_TOOLS } from '../src/mcp/ops/assistant-items.js'
import { ASSISTANT_REMINDER_TOOLS, assistantReminderToolsFor } from '../src/mcp/ops/assistant-reminders.js'
import type { ShareTargetResult } from '../src/mcp/ops/share-file.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import type { AssistantPlace } from '../src/store/assistant-items.js'
import {
  ASSISTANT_REMINDER_CLAIM_STALE_MS,
  ASSISTANT_REMINDER_PENDING_MAX,
  type AssistantReminder,
  type AssistantReminderCreate
} from '../src/store/assistant-reminders.js'
import { sessionKey, transcriptChannelKey, type LocalStore } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { openTestStore } from './store-support.js'

const AGENT = 'agent-a'
const INT = 'int-1'
const SCOPE = 'T0EXAMPLE'
const NAMES = ['remind', 'listReminders', 'cancelReminder']
const T0 = Date.parse('2026-10-10T08:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  agentId: AGENT,
  platform: 'slack',
  integrationId: INT,
  transportScope: SCOPE,
  isDm: true,
  channel: 'D0ALICE',
  thread: 'append:1',
  deliveryThread: '1700000000.000100',
  tools: ASSISTANT_REMINDER_TOOLS,
  ...over
})
const ALICE_DM = session()
const GENERAL = session({ channel: 'C0GENERAL', isDm: false, thread: 'append:2', deliveryThread: '1700000000.000200' })
const placeOf = (ctx: SessionContext): AssistantPlace => ({
  platform: ctx.platform,
  channel: ctx.channel,
  transportScope: ctx.transportScope ?? null
})

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

/** The tool deps over a real ledger: the live turn posts where the session's replies land, unless the test says otherwise. */
async function tools(options: { enabled?: boolean; external?: string[]; deps?: Partial<OpsDeps> } = {}) {
  store = await openTestStore()
  const s = store
  let now = T0
  const external = new Set(options.external ?? [])
  const share = vi.fn((ctx: SessionContext): ShareTargetResult => ({
    ok: true,
    platform: ctx.platform,
    ...(ctx.integrationId ? { integrationId: ctx.integrationId } : {}),
    channel: ctx.channel,
    thread: ctx.deliveryThread
  }))
  const deps = {
    assistantReminders: {
      ledgerFor: () => (options.enabled === false ? undefined : s.assistantReminders),
      requesterFor: async () => 'U0ALICE',
      now: () => now
    },
    shareTarget: share,
    placeExternal: (ctx: SessionContext) => external.has(ctx.channel),
    ...options.deps
  } as unknown as OpsDeps
  const call = (ctx: SessionContext, name: string, args: Record<string, unknown>) =>
    executeTool(ctx, name, args, deps) as Promise<any>
  return { store: s, call, share, deps, advance: (ms: number) => (now += ms) }
}

const at = (ms: number): string => new Date(ms).toISOString()

describe('the reminder tools are offered only to assistant-mode agents, in a conversation of the session’s own', () => {
  it('derives the offered set from the switch and the session, and reserves every name', () => {
    const own = { thread: 'append:1', integrationId: INT }
    expect(assistantReminderToolsFor({}, own)).toEqual([])
    expect(assistantReminderToolsFor({ assistantMode: { enabled: false } }, own)).toEqual([])
    expect(assistantReminderToolsFor({ assistantMode: { enabled: true } }, own).map((t) => t.name)).toEqual(NAMES)
    // A background session and a session with no platform conversation are offered none.
    expect(
      assistantReminderToolsFor({ assistantMode: { enabled: true } }, { ...own, thread: 'subsession:d-1' })
    ).toEqual([])
    expect(assistantReminderToolsFor({ assistantMode: { enabled: true } }, { thread: 'webchat:w-1' })).toEqual([])
    expect(ALL_TOOL_NAMES).toEqual(expect.arrayContaining(NAMES))
  })

  it('refuses every reminder tool once the agent is not in assistant mode', async () => {
    const { call, store: s } = await tools({ enabled: false })
    for (const [name, args] of [
      ['remind', { at: at(T0 + HOUR), message: 'x' }],
      ['listReminders', {}],
      ['cancelReminder', { id: 'r-1' }]
    ] as const)
      await expect(call(ALICE_DM, name, args)).rejects.toThrow('only to an agent in assistant mode')
    expect(await s.assistantReminders.listOpen(AGENT, placeOf(ALICE_DM))).toEqual([])
  })

  it('tells the model the text is posted as written, by the daemon, with no turn, here only', () => {
    const remind = ASSISTANT_REMINDER_TOOLS.find((t) => t.name === 'remind')!.description
    expect(remind).toContain('the daemon posts `message` here exactly as written')
    expect(remind).toContain('with no model turn')
    expect(remind).toContain('into this conversation only, never anywhere else')
  })
})

describe('remind', () => {
  it('records the reminder in this conversation, in the thread its replies land in', async () => {
    const { call, store: s } = await tools()
    const result = await call(ALICE_DM, 'remind', { at: '2026-10-10T17:30:00+08:00', message: 'Send the report.' })
    expect(result).toEqual({ id: expect.any(String), at: '2026-10-10T09:30:00.000Z', note: expect.any(String) })
    expect(await s.assistantReminders.get(AGENT, result.id)).toMatchObject({
      place: placeOf(ALICE_DM),
      integrationId: INT,
      thread: 'append:1',
      targetThread: '1700000000.000100',
      targetDm: true,
      message: 'Send the report.',
      dueAt: T0 + 90 * MINUTE,
      status: 'pending',
      requesterId: 'U0ALICE'
    })
  })

  it('refuses a past or present time, more than 366 days ahead, an instant without an offset, and empty or overlong text', async () => {
    const { call, store: s } = await tools()
    await expect(call(ALICE_DM, 'remind', { at: at(T0 - MINUTE), message: 'x' })).rejects.toThrow('in the future')
    await expect(call(ALICE_DM, 'remind', { at: at(T0), message: 'x' })).rejects.toThrow('in the future')
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + 366 * DAY + 1_000), message: 'x' })).rejects.toThrow(
      'at most 366 days'
    )
    await expect(call(ALICE_DM, 'remind', { at: '2026-10-10T17:30:00', message: 'x' })).rejects.toThrow(
      'ISO-8601 instant with an offset'
    )
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: '' })).rejects.toThrow('message')
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: '   ' })).rejects.toThrow('must not be empty')
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: 'x'.repeat(40_001) })).rejects.toThrow(
      'at most 40000 characters'
    )
    expect(await s.assistantReminders.listOpen(AGENT, placeOf(ALICE_DM))).toEqual([])
    // The far edge itself is allowed.
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + 366 * DAY), message: 'x' })).resolves.toHaveProperty('id')
  })

  it('refuses beyond the agent’s pending cap, counted across its conversations', async () => {
    const { call, store: s } = await tools()
    for (let i = 0; i < ASSISTANT_REMINDER_PENDING_MAX; i++)
      expect(await s.assistantReminders.create(row({ place: placeOf(GENERAL), dueAt: T0 + HOUR + i }))).toBeDefined()
    await expect(call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: 'one more' })).rejects.toThrow(
      `already holds ${ASSISTANT_REMINDER_PENDING_MAX} pending reminders`
    )
    expect(await s.assistantReminders.listOpen(AGENT, placeOf(ALICE_DM))).toEqual([])
  })

  it('is refused in a sub-session, a patrol, an external place, webchat and a turn that posts nothing', async () => {
    const { call, store: s, share } = await tools({ external: ['C0SHARED'] })
    const args = { at: at(T0 + HOUR), message: 'x' }
    await expect(call(session({ thread: 'subsession:d-1' }), 'remind', args)).rejects.toThrow(
      'background session with no conversation of its own'
    )
    await expect(
      call(session({ thread: 'subsession:patrol-d-2', tools: ASSISTANT_ITEM_TOOLS }), 'remind', args)
    ).rejects.toThrow('remind is not available in a read-only patrol')
    await expect(call(session({ channel: 'C0SHARED', isDm: false }), 'remind', args)).rejects.toThrow(
      'shared with another organization'
    )
    const { integrationId: _none, ...webchat } = session({ platform: 'webchat', channel: 'w-1', thread: 'webchat:w-1' })
    await expect(call(webchat, 'remind', args)).rejects.toThrow('webchat is not supported yet')
    share.mockReturnValueOnce({ ok: false, reason: 'headless' })
    await expect(call(GENERAL, 'remind', args)).rejects.toThrow('posts nothing visible')
    share.mockReturnValueOnce({ ok: false, reason: 'no-conversation' })
    await expect(call(GENERAL, 'remind', args)).rejects.toThrow('no conversation of its own')
    // A turn that would post into another conversation is never taken for this one.
    share.mockReturnValueOnce({ ok: true, platform: 'slack', integrationId: INT, channel: 'C0OTHER' })
    await expect(call(GENERAL, 'remind', args)).rejects.toThrow('this conversation has none')
    for (const ctx of [ALICE_DM, GENERAL, session({ channel: 'C0SHARED' })])
      expect(await s.assistantReminders.listOpen(AGENT, placeOf(ctx))).toEqual([])
  })
})

/** A ledger row of the agent, due an hour from T0 in Alice's DM unless the test says otherwise. */
const row = (over: Partial<AssistantReminderCreate> = {}): AssistantReminderCreate => ({
  id: randomUUID(),
  agentId: AGENT,
  place: placeOf(ALICE_DM),
  integrationId: INT,
  thread: 'append:1',
  targetThread: '1700000000.000100',
  targetDm: true,
  message: 'Send the report.',
  dueAt: T0 + HOUR,
  requesterId: 'U0ALICE',
  now: T0,
  ...over
})

describe('listReminders and cancelReminder stay in their conversation', () => {
  it('lists this conversation’s pending reminders only, and cancels only those', async () => {
    const { call, store: s } = await tools()
    const mine = (await call(ALICE_DM, 'remind', { at: at(T0 + 2 * HOUR), message: 'Stand-up notes.' })).id
    const sooner = (await call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: 'Send the report.' })).id
    const theirs = (await call(GENERAL, 'remind', { at: at(T0 + HOUR), message: 'Deploy window opens.' })).id
    expect((await call(ALICE_DM, 'listReminders', {})).reminders).toEqual([
      { id: sooner, at: at(T0 + HOUR), message: 'Send the report.', status: 'pending' },
      { id: mine, at: at(T0 + 2 * HOUR), message: 'Stand-up notes.', status: 'pending' }
    ])
    expect((await call(GENERAL, 'listReminders', {})).reminders.map((r: any) => r.id)).toEqual([theirs])
    // Another conversation's reminder reads as unknown here and stays pending.
    await expect(call(ALICE_DM, 'cancelReminder', { id: theirs })).rejects.toThrow(
      `no reminder ${theirs} was set in this conversation`
    )
    expect((await s.assistantReminders.get(AGENT, theirs))?.status).toBe('pending')
    expect(await call(ALICE_DM, 'cancelReminder', { id: mine })).toMatchObject({
      cancelled: true,
      reminder: { id: mine, status: 'cancelled' }
    })
    expect((await call(ALICE_DM, 'listReminders', {})).reminders.map((r: any) => r.id)).toEqual([sooner])
    // One already posted can no longer be cancelled.
    await s.assistantReminders.claim(AGENT, sooner, T0 + HOUR)
    await expect(call(ALICE_DM, 'cancelReminder', { id: sooner })).rejects.toThrow('being posted right now')
    await s.assistantReminders.settle(AGENT, sooner, { status: 'delivered', messageId: 'ts-1' }, T0 + HOUR)
    await expect(call(ALICE_DM, 'cancelReminder', { id: sooner })).rejects.toThrow('no longer pending (delivered)')
  })

  it('has no conversation to list or cancel in a background session', async () => {
    const { call } = await tools()
    const background = session({ thread: 'subsession:d-1' })
    await expect(call(background, 'listReminders', {})).rejects.toThrow('background session')
    await expect(call(background, 'cancelReminder', { id: 'r-1' })).rejects.toThrow('background session')
  })
})

describe('a DM conversation marked by a per-asker read', () => {
  it('still sets, lists and cancels reminders, which land only in that DM', async () => {
    const widened = { mark: vi.fn(async () => true), marked: vi.fn(async () => true), placeMarked: async () => true }
    const { call, store: s } = await tools({ deps: { assistantModeFor: () => true, widenedSession: widened } })
    // The mark is in force: a ledger write is refused.
    await expect(call(ALICE_DM, 'takeItem', { title: 'x', doneWhen: 'y' })).rejects.toThrow(/`!new`/)
    const { id } = await call(ALICE_DM, 'remind', { at: at(T0 + HOUR), message: 'Check the merger memo.' })
    expect((await call(ALICE_DM, 'listReminders', {})).reminders.map((r: any) => r.id)).toEqual([id])
    expect(await s.assistantReminders.get(AGENT, id)).toMatchObject({ place: placeOf(ALICE_DM), targetDm: true })
    expect(await call(ALICE_DM, 'cancelReminder', { id })).toMatchObject({ cancelled: true })
  })
})

/** The delivery service over a real ledger, with the platform and the place faked. */
async function delivery(options: { external?: string[]; enabled?: boolean } = {}) {
  store = await openTestStore()
  const s = store
  let now = T0
  const external = new Set(options.external ?? [])
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const agentsOn = new Map<string, boolean>([[AGENT, true]])
  const host = {
    now: () => now,
    log,
    agents: () => [...agentsOn].map(([id, on]) => ({ id, assistantMode: { enabled: on } })),
    mayDeliver: vi.fn((_agentId: string) => true),
    draining: () => false,
    reminders: s.assistantReminders,
    placeEnabled: vi.fn(() => options.enabled !== false),
    placeExternal: (_agentId: string, _integrationId: string, channel: string) => external.has(channel),
    post: vi.fn(async (_reminder: AssistantReminder): Promise<string | undefined> => 'ts-posted'),
    draft: vi.fn(async (_reminder: AssistantReminder) => 'draft-1')
  } satisfies AssistantRemindersHost
  return {
    store: s,
    host,
    log,
    external,
    agentsOn,
    reminders: new AssistantReminders(host),
    another: () => new AssistantReminders(host),
    set: async (over: Partial<AssistantReminderCreate> = {}) => (await s.assistantReminders.create(row(over)))!,
    get: async (id: string) => (await s.assistantReminders.get(AGENT, id))!,
    at: (ms: number) => (now = ms)
  }
}

describe('delivery', () => {
  it('posts a due reminder once, not before its time, however often the sweep runs', async () => {
    const h = await delivery()
    const r = await h.set()
    h.at(T0 + HOUR - 1)
    await h.reminders.sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    h.at(T0 + HOUR + 30_000)
    await h.reminders.sweep()
    await h.reminders.sweep()
    expect(h.host.post).toHaveBeenCalledTimes(1)
    expect(h.host.post.mock.calls[0]![0]).toMatchObject({ id: r.id, message: 'Send the report.' })
    expect(await h.get(r.id)).toMatchObject({ status: 'delivered', attempts: 1, messageId: 'ts-posted' })
  })

  it('posts once when two daemons sweep at the same time', async () => {
    const h = await delivery()
    const r = await h.set()
    h.at(T0 + HOUR)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    h.host.post.mockImplementationOnce(async () => {
      await gate
      return 'ts-posted'
    })
    const first = h.reminders.sweep()
    const second = h.another().sweep()
    await second
    release()
    await first
    expect(h.host.post).toHaveBeenCalledTimes(1)
    expect((await h.get(r.id)).status).toBe('delivered')
  })

  it('is left to the daemon holding the agent’s duty, and to an agent in assistant mode', async () => {
    const h = await delivery()
    const r = await h.set()
    h.at(T0 + HOUR)
    h.host.mayDeliver.mockReturnValue(false)
    await h.reminders.sweep()
    expect(h.host.mayDeliver).toHaveBeenCalledWith(AGENT)
    h.host.mayDeliver.mockReturnValue(true)
    h.agentsOn.set(AGENT, false)
    await h.reminders.sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    expect((await h.get(r.id)).status).toBe('pending')
    h.agentsOn.set(AGENT, true)
    await h.reminders.sweep()
    expect(h.host.post).toHaveBeenCalledTimes(1)
  })

  it('retries a platform error on later sweeps, then fails it after three attempts with a warning', async () => {
    const h = await delivery()
    const r = await h.set()
    h.at(T0 + HOUR)
    h.host.post.mockRejectedValue(new Error('ratelimited'))
    await h.reminders.sweep()
    expect(await h.get(r.id)).toMatchObject({ status: 'pending', attempts: 1, failure: 'ratelimited' })
    await h.reminders.sweep()
    expect(await h.get(r.id)).toMatchObject({ status: 'pending', attempts: 2 })
    expect(h.log.warn).not.toHaveBeenCalled()
    await h.reminders.sweep()
    expect(await h.get(r.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      failure: expect.stringContaining('ratelimited')
    })
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining(`reminder ${r.id}`))
    await h.reminders.sweep()
    expect(h.host.post).toHaveBeenCalledTimes(3)
  })

  it('delivers nothing while paused; after the pause, a reminder under 24 hours late posts and an older one expires', async () => {
    const h = await delivery()
    const old = await h.set({ dueAt: T0 + HOUR })
    const recent = await h.set({ dueAt: T0 + 10 * HOUR })
    const paused = { on: true }
    h.host.mayDeliver.mockImplementation(() => !paused.on)
    h.at(T0 + 26 * HOUR)
    await h.reminders.sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    expect((await h.get(old.id)).status).toBe('pending')
    paused.on = false
    await h.reminders.sweep()
    expect((await h.get(old.id)).status).toBe('expired')
    expect(await h.get(recent.id)).toMatchObject({ status: 'delivered' })
    expect(h.host.post).toHaveBeenCalledTimes(1)
    expect(h.host.post.mock.calls[0]![0]).toMatchObject({ id: recent.id })
  })

  it('drafts the text for approval when the conversation turned external after it was set', async () => {
    const h = await delivery()
    const r = await h.set()
    h.external.add(placeOf(ALICE_DM).channel)
    h.at(T0 + HOUR)
    await h.reminders.sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    expect(h.host.draft).toHaveBeenCalledTimes(1)
    expect(await h.get(r.id)).toMatchObject({ status: 'drafted', draftId: 'draft-1', messageId: null })
  })

  it('fails without posting where the agent is no longer enabled', async () => {
    const h = await delivery({ enabled: false })
    const r = await h.set()
    h.at(T0 + HOUR)
    await h.reminders.sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    expect(await h.get(r.id)).toMatchObject({ status: 'failed', failure: expect.stringContaining('no longer enabled') })
    expect(h.log.warn).toHaveBeenCalledTimes(1)
  })

  it('never posts a reminder whose delivery a restart or handover cut short', async () => {
    const h = await delivery()
    const r = await h.set()
    // A daemon claimed it and was gone before it settled.
    expect(await h.store.assistantReminders.claim(AGENT, r.id, T0 + HOUR)).toBe(1)
    h.at(T0 + HOUR + ASSISTANT_REMINDER_CLAIM_STALE_MS - 1)
    await h.another().sweep()
    expect((await h.get(r.id)).status).toBe('delivering')
    h.at(T0 + HOUR + ASSISTANT_REMINDER_CLAIM_STALE_MS + 1)
    await h.another().sweep()
    expect(h.host.post).not.toHaveBeenCalled()
    expect((await h.get(r.id)).status).toBe('failed')
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining(`reminder ${r.id}: a delivery was cut short`))
  })
})

// The daemon's own wiring: the tool through the bridge deps, the sweep, the draft path's post, and the duty gate.
const BOT = 'bot-a'
const BOT_INT = 'int-bot-a'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-remind-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', BOT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: BOT,
      name: BOT,
      displayName: 'Butler',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: BOT_INT,
          platform: 'slack',
          core: {
            gated: true,
            bindRules: [{ match: { kind: 'mention' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'append' }],
            externalChannels: []
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' },
      assistantMode: { enabled: true, responsibleUserId: 'usr-1' }
    })
  )
  return root
}

async function bootDaemon() {
  const root = scaffold()
  // Wall time with an offset the test moves forward; timers stay real.
  const clock = {
    offset: 0,
    now(): number {
      return Date.now() + this.offset
    },
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
  const daemon = new Daemon({
    root,
    clock,
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: () =>
      ({
        __started: true,
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        prompt: async () => ({ stopReason: 'end_turn' })
      }) as never
  })
  await daemon.start()
  const d = daemon as any
  const conn = {
    workspaceId: () => 'T_FAKE_TEAM',
    workspaceUrl: 'https://example.slack.test',
    postMessage: vi.fn(async () => '1700000000.000900'),
    postBlocks: vi.fn(async () => 'card-1'),
    updateBlocks: vi.fn(async () => true),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`),
    isFullMember: vi.fn(async () => true),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general', isPrivate: false }))
  }
  d.connByIntegration.set(BOT_INT, conn)
  const scope: string = d.transportScopeForIntegrationIds([BOT_INT])
  const coordinate: string = await d.store.resolveAppendCoordinate(BOT, 'C1', scope, 1)
  const ctx: SessionContext = {
    agentId: BOT,
    platform: 'slack',
    integrationId: BOT_INT,
    transportScope: scope,
    isDm: false,
    channel: 'C1',
    thread: coordinate,
    deliveryThread: '1700000000.000100',
    tools: ASSISTANT_REMINDER_TOOLS
  }
  // The live turn's own post target, as the turn engine records it for shareFile.
  d.activeTurnShare.set(sessionKey('slack', 'C1', coordinate, BOT, scope), {
    platform: 'slack',
    integrationId: BOT_INT,
    channel: 'C1',
    thread: '1700000000.000100',
    headless: false,
    synthetic: false
  })
  const deps = { ...d.mcp.deps, canRun: () => true }
  const pending = async (): Promise<AssistantReminder[]> =>
    await d.store.assistantReminders.listOpen(BOT, { platform: 'slack', channel: 'C1', transportScope: scope })
  return {
    d,
    conn,
    ctx,
    deps,
    pending,
    later: (ms: number) => (clock.offset += ms),
    remind: async (dueAt: number) =>
      (await executeTool(
        ctx,
        'remind',
        { at: new Date(dueAt).toISOString(), message: 'Release notes are due.' },
        deps
      )) as {
        id: string
      },
    get: async (id: string): Promise<AssistantReminder> => await d.store.assistantReminders.get(BOT, id),
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('the daemon delivers reminders', () => {
  it('posts the text as the agent, in the thread of the conversation it was set in, with no turn', async () => {
    const h = await bootDaemon()
    try {
      const { id } = await h.remind(Date.now() + MINUTE)
      expect(await h.pending()).toHaveLength(1)
      h.later(2 * MINUTE)
      const dispatch = vi.spyOn(h.d, 'dispatch')
      await h.d.reminders.sweep()
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
      expect(h.conn.postMessage).toHaveBeenCalledWith(
        'C1',
        'Release notes are due.',
        '1700000000.000100',
        expect.objectContaining({ username: 'Butler', agentAuthorId: BOT })
      )
      expect(dispatch).not.toHaveBeenCalled()
      expect(await h.get(id)).toMatchObject({ status: 'delivered', messageId: '1700000000.000900' })
      // Recorded in the thread like any message the agent sends, so a reply to it reaches the conversation.
      const rows = await h.d.store.threadTranscript(
        transcriptChannelKey('C1', h.ctx.transportScope),
        '1700000000.000100'
      )
      expect(rows).toEqual([
        expect.objectContaining({ sender: BOT, text: 'Release notes are due.', ts: '1700000000.000900' })
      ])
      await h.d.reminders.sweep()
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('leaves the reminder pending on a daemon without the agent’s duty, and while the agent is paused', async () => {
    const h = await bootDaemon()
    try {
      const { id } = await h.remind(Date.now() + MINUTE)
      h.later(2 * MINUTE)
      h.d.servesAgent = () => false
      await h.d.reminders.sweep()
      h.d.servesAgent = () => true
      h.d.agents.get(BOT).pause = true
      await h.d.reminders.sweep()
      expect(h.conn.postMessage).not.toHaveBeenCalled()
      expect((await h.get(id)).status).toBe('pending')
      h.d.agents.get(BOT).pause = false
      await h.d.reminders.sweep()
      expect(h.conn.postMessage).toHaveBeenCalledTimes(1)
    } finally {
      await h.close()
    }
  })

  it('drafts the text to the person who set it once the conversation turned external, and posts nothing there', async () => {
    const h = await bootDaemon()
    try {
      const { id } = await h.remind(Date.now() + MINUTE)
      // Set by a person in the conversation, which a later share turned external.
      await h.d.store.assistantReminders['db'].query('UPDATE assistant_reminder SET requesterId = ? WHERE id = ?', [
        'U1',
        id
      ])
      h.d.agents.get(BOT).integrations[0].core.externalChannels.push('C1')
      h.later(2 * MINUTE)
      await h.d.reminders.sweep()
      expect(h.conn.postMessage).not.toHaveBeenCalled()
      const reminder = await h.get(id)
      expect(reminder).toMatchObject({ status: 'drafted', draftId: expect.any(String) })
      expect(await h.d.store.assistantDrafts.get(reminder.draftId)).toMatchObject({
        kind: 'reply',
        status: 'awaiting_review',
        text: 'Release notes are due.',
        target: { platform: 'slack', integrationId: BOT_INT, channel: 'C1', thread: '1700000000.000100' },
        targetExternal: true,
        approver: { kind: 'member', channel: 'D_U1', userId: 'U1' }
      })
      // The card is the only message, in the DM of the person who set it.
      expect(h.conn.postBlocks).toHaveBeenCalledTimes(1)
      expect((h.conn.postBlocks.mock.calls[0] as unknown[])[0]).toBe('D_U1')
    } finally {
      await h.close()
    }
  })
})
