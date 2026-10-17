// Every agent's capture, memory tools and dreams follow the conversation's layer (unified-memory-interface.md §6).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IntegrationChannel, MemoryEntryMutationReceipt } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { MEMBERS_FILE_ENTRY_TOOLS_ONLY, type MemoryToolCall } from '../src/mcp/ops/memory.js'
import { MEMORY_LAYER_NOTES } from '../src/memory/entries/tools.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { memoryChannelKey, memoryPersonKey } from '../src/memory/store.js'
import {
  MEMORY_PERSON_LAYER_REFUSED,
  MEMORY_SHARED_LAYER_EXTERNAL,
  MEMORY_SHARED_LAYER_NEEDS_PERSON,
  MEMORY_SHARED_LAYER_ONLY
} from '../src/memory/tools.js'
import { openTestStore } from './store-support.js'
import { sessionKey } from '../src/store/local-store.js'
import { appendCoordinate } from '../src/session/append-coordinate.js'
import { firstLookCoordinate } from '../src/session/subsession-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
// What a check's or another agent's message carries as its sender: an agent's UUID.
const AGENT_UUID = '0b0b0b0b-0000-4000-8000-000000000001'
const THREAD = appendCoordinate(1)
const TENANT = 'T-EXAMPLE'

interface Place {
  platform?: string
  channel?: string
  conversationKind?: 'dm' | 'channel' | 'group_dm'
  triggeredBy?: string
  /** What a membership listing reported, on the agent's own integration. */
  snapshot?: Partial<IntegrationChannel>
  /** The CP or a detection marked it external. */
  external?: boolean
  /** What the platform's own lookup answers for the conversation; an Error makes it fail. */
  lookup?: Record<string, unknown> | Error
}

interface Agent {
  assistant?: boolean
  provider?: 'managed' | 'external'
  /** The retired Agent/Channel choice, still stored on older bindings. */
  scope?: 'agent' | 'channel'
  linked?: Record<string, string>
}

function world(place: Place, agent: Agent = {}) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  const platform = place.platform ?? 'slack'
  const channel = place.channel ?? 'C1'
  const key = sessionKey(platform, channel, THREAD, AGENT)
  const row = {
    key,
    agentId: AGENT,
    platform,
    channel,
    thread: THREAD,
    updatedAt: 1,
    conversationKind: place.conversationKind ?? (platform === 'webchat' ? null : 'channel'),
    triggeredBy: place.triggeredBy ?? null
  }
  // Like the real gate: a DM or a console conversation is capture-excluded, and so is a CP-confirmed private one.
  const excluded = row.conversationKind === 'dm' || platform === 'webchat' || place.snapshot?.isPrivate === true
  daemon.store = {
    isCaptureExcluded: vi.fn(async () => excluded),
    getSession: vi.fn(async (k: string) => (k === key ? row : undefined)),
    listSessions: vi.fn(async () => [row])
  }
  daemon.memory = { recordTurnForBinding: vi.fn(async () => {}) }
  const provider = agent.provider ?? 'managed'
  daemon.agents.set(AGENT, {
    id: AGENT,
    memory:
      provider === 'managed'
        ? { provider, home: 'daemon', ...(agent.scope ? { scope: agent.scope } : {}) }
        : { provider, connectionId: '00000000-0000-4000-8000-000000000001' },
    integrations: [
      {
        id: 'int-1',
        platform: 'slack',
        ...(place.external ? { core: { externalChannels: [channel] } } : {})
      },
      { id: 'int-2', platform: 'telegram' }
    ],
    ...(agent.assistant ? { assistantMode: { enabled: true } } : {})
  })
  if (place.snapshot) {
    const integrationId = platform === 'telegram' ? 'int-2' : 'int-1'
    daemon.channelSnapshots.set(integrationId, { channels: [{ id: channel, ...place.snapshot }], authoritative: true })
  }
  if (place.lookup !== undefined) {
    const answer = place.lookup
    const getChannelInfo = vi.fn(async (id: string) => {
      if (answer instanceof Error) throw answer
      return { id, ...answer }
    })
    daemon.connForIntegration = (integrationId: string) => (integrationId === 'int-1' ? { getChannelInfo } : undefined)
  }
  daemon.tenantScopeForIntegration = async () => TENANT
  daemon.linkedConsoleUser = async (_agent: string, _int: string, member: string) => agent.linked?.[member]
  const captured = async (msg?: unknown): Promise<unknown> => {
    daemon.memory.recordTurnForBinding.mockClear()
    await daemon.queueMemoryPostTurn(
      AGENT,
      'acp-1',
      'turn-1',
      'in',
      'out',
      daemon.agents.get(AGENT).memory,
      undefined,
      'turn-1',
      { key, outwardSessionId: 'outward-1' },
      msg
    )
    await Promise.all(daemon.memoryPostTurnChains.values())
    return daemon.memory.recordTurnForBinding.mock.calls[0]?.[0]
  }
  const ctx = {
    agentId: AGENT,
    platform,
    channel,
    thread: THREAD,
    deliveryThread: THREAD,
    isDm: row.conversationKind === 'dm',
    tools: []
  } as unknown as SessionContext
  const tool = (call: { mode: 'read' | 'write'; layer?: 'shared' | 'person' | 'here' }) =>
    daemon.memoryToolScope(ctx, call)
  // What the session manager resolves when a session starts on this message, before its row exists.
  const start = async (msg: unknown) =>
    (await daemon.memoryLayerFor(daemon.memoryPlaceOf(AGENT, { platform, channel }, undefined, msg))).scope
  // The session's live turn: the message it answers, and any folded into it.
  const turn = (msg: unknown, folded: unknown[] = []) =>
    daemon.activeGateEntries.set(key, { msg, integrationId: 'int-1', foldedMessages: folded.map((m) => ({ msg: m })) })
  return { daemon, captured, tool, ctx, start, turn }
}

const PUBLIC = { isPrivate: false, externalReason: null }
// A message a person typed, and the rounds no person starts, as the daemon builds them.
const TYPED = { source: 'user', platform: 'slack', sender: { id: 'U1', isBot: false }, isDm: false }
const ROUNDS = {
  report: { source: 'agent', sender: { id: AGENT, isBot: true }, parentReport: true, isDm: false },
  check: { source: 'agent', sender: { id: AGENT, isBot: true }, headless: true, isDm: false },
  'session message': { source: 'agent', sender: { id: AGENT_UUID, isBot: true }, isDm: false },
  schedule: { source: 'cron', sender: { id: 'cron:daily', isBot: false }, isDm: false }
}

// assistant-mode.md §5.13: memory gets only what the place's long session writes from a first look's report.
describe('a first look’s own session', () => {
  it('captures nothing, where the same place’s long session would', async () => {
    const { daemon, captured } = world({ snapshot: PUBLIC }, { assistant: true })
    expect(await captured()).toBeDefined()
    const rowOf = daemon.store.getSession
    daemon.store.getSession = vi.fn(async (k: string) => {
      const row = await rowOf(k)
      return row && { ...row, thread: firstLookCoordinate('1') }
    })
    expect(await captured()).toBeUndefined()
  })
})

describe('per-turn capture writes to the conversation layer, for every agent', () => {
  it.each([false, true])(
    'assistant mode %s: a public internal Slack channel distills into the shared layer',
    async (assistant) => {
      const scope = await world({ snapshot: PUBLIC }, { assistant }).captured()
      expect(scope).toMatchObject({ agentId: AGENT, channelKey: memoryChannelKey('C1'), sharedPlace: true })
      expect(scope).not.toHaveProperty('personKey')
    }
  )

  it.each([false, true])(
    'assistant mode %s: a private channel distills into its own place layer',
    async (assistant) => {
      const scope = await world({ snapshot: { isPrivate: true } }, { assistant }).captured()
      expect(scope).toEqual({
        agentId: AGENT,
        channelKey: memoryChannelKey('C1'),
        channel: 'C1',
        platform: 'slack',
        sessionId: 'outward-1'
      })
    }
  )

  it.each([false, true])("assistant mode %s: a DM distills into its person's layer", async (assistant) => {
    const scope = await world({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }, { assistant }).captured()
    expect(scope).toEqual({ agentId: AGENT, personKey: memoryPersonKey(`slack:${TENANT}:U1`), sessionId: 'outward-1' })
  })

  it('a webchat conversation distills into its owner’s layer', async () => {
    const scope = await world({ platform: 'webchat', channel: 'conv-1', triggeredBy: 'user-1' }).captured()
    expect(scope).toEqual({ agentId: AGENT, personKey: memoryPersonKey('user:user-1'), sessionId: 'outward-1' })
  })

  it('a Slack Connect channel keeps its own place layer', async () => {
    for (const place of [
      { snapshot: { isPrivate: false, externalReason: 'externallyShared' as const } },
      { snapshot: PUBLIC, external: true }
    ]) {
      expect(await world(place).captured()).toMatchObject({ channelKey: memoryChannelKey('C1') })
      expect(await world(place).captured()).not.toHaveProperty('sharedPlace')
    }
  })

  it('a public Telegram group keeps its own place layer, and two groups never share one', async () => {
    const a = await world({ platform: 'telegram', channel: '-1001', snapshot: { isPrivate: false } }).captured()
    const b = await world({ platform: 'telegram', channel: '-1002', snapshot: { isPrivate: false } }).captured()
    expect(a).toMatchObject({ channelKey: memoryChannelKey('-1001') })
    expect(b).toMatchObject({ channelKey: memoryChannelKey('-1002') })
    expect(a).not.toHaveProperty('sharedPlace')
  })

  it('never puts a capture-excluded turn into the shared layer', async () => {
    const w = world({ snapshot: PUBLIC })
    w.daemon.store.isCaptureExcluded = vi.fn(async () => true)
    expect(await w.captured()).toBeUndefined()
  })
})

describe('external memory keeps the shared layer alone', () => {
  it('captures only from a shared conversation', async () => {
    expect(await world({ snapshot: PUBLIC }, { provider: 'external' }).captured()).toEqual({
      agentId: AGENT,
      sessionId: 'outward-1'
    })
    for (const place of [
      { snapshot: { isPrivate: true } },
      { channel: 'D1', conversationKind: 'dm' as const, triggeredBy: 'U1' },
      { platform: 'webchat', channel: 'conv-1', triggeredBy: 'user-1' }
    ])
      expect(await world(place, { provider: 'external' }).captured()).toBeUndefined()
  })

  it('refuses a default write from a DM, and takes one the person asked to share with everyone', async () => {
    const w = world({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }, { provider: 'external' })
    w.turn({ ...TYPED, isDm: true })
    await expect(w.tool({ mode: 'write' })).rejects.toThrow(MEMORY_SHARED_LAYER_ONLY)
    expect(await w.tool({ mode: 'read' })).toEqual({ agentId: AGENT })
    expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
  })

  it('refuses a named shared write from a private place on a round no person started', async () => {
    const w = world({ snapshot: { isPrivate: true } }, { provider: 'external' })
    w.turn(ROUNDS.report)
    await expect(w.tool({ mode: 'write', layer: 'shared' })).rejects.toThrow(MEMORY_SHARED_LAYER_NEEDS_PERSON)
  })
})

describe("explicit memory tools: the session's layer, or the one `layer` names", () => {
  it('writes a DM to the person layer with no card, and to the shared layer when asked for everyone', async () => {
    const w = world({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' })
    w.turn({ ...TYPED, isDm: true })
    expect(await w.tool({ mode: 'write' })).toEqual({
      agentId: AGENT,
      personKey: memoryPersonKey(`slack:${TENANT}:U1`)
    })
    expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
    expect(await w.tool({ mode: 'read', layer: 'here' })).toMatchObject({ alone: true })
  })

  it('writes a private channel to its place layer', async () => {
    const w = world({ snapshot: { isPrivate: true } })
    expect(await w.tool({ mode: 'write' })).toMatchObject({ channelKey: memoryChannelKey('C1') })
  })

  it("reaches the asker's own person layer from a channel only when that person is the whole turn", async () => {
    const w = world({ snapshot: PUBLIC }, { linked: { U1: 'user-1' } })
    const owner = { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U1' }
    w.daemon.readAskersFor = async () => ({ people: [owner], nobody: false })
    expect(await w.tool({ mode: 'read', layer: 'person' })).toEqual({
      agentId: AGENT,
      personKey: memoryPersonKey('user:user-1'),
      alone: true
    })
    expect(await w.tool({ mode: 'write', layer: 'person' })).toMatchObject({
      personKey: memoryPersonKey('user:user-1')
    })
    const other = { kind: 'member', platform: 'slack', integrationId: 'int-1', userId: 'U2' }
    w.daemon.readAskersFor = async () => ({ people: [owner, other], nobody: false })
    await expect(w.tool({ mode: 'read', layer: 'person' })).rejects.toThrow(MEMORY_PERSON_LAYER_REFUSED)
    w.daemon.readAskersFor = async () => ({ people: [], nobody: true })
    await expect(w.tool({ mode: 'write', layer: 'person' })).rejects.toThrow(MEMORY_PERSON_LAYER_REFUSED)
  })

  it("gives a linked person's Slack DM and webchat conversation the same layer", async () => {
    const linked = { U1: 'user-1' }
    const dm = await world({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }, { linked }).tool({
      mode: 'write'
    })
    const web = await world({ platform: 'webchat', channel: 'conv-1', triggeredBy: 'user-1' }, { linked }).tool({
      mode: 'write'
    })
    expect(dm).toEqual({ agentId: AGENT, personKey: memoryPersonKey('user:user-1') })
    expect(web).toEqual(dm)
  })
})

describe('a named shared write needs a person on the turn, and never comes from outsiders', () => {
  const NARROWER: [string, Place][] = [
    ['a private channel', { snapshot: { isPrivate: true } }],
    ['a group DM', { channel: 'G1', conversationKind: 'group_dm' }],
    ['a 1:1 DM', { channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }]
  ]

  it.each(NARROWER)('refuses it in %s on a report, check, session-message or schedule round', async (_, place) => {
    const w = world(place)
    await expect(w.tool({ mode: 'write', layer: 'shared' })).rejects.toThrow(MEMORY_SHARED_LAYER_NEEDS_PERSON)
    for (const msg of Object.values(ROUNDS)) {
      w.turn(msg)
      await expect(w.tool({ mode: 'write', layer: 'shared' })).rejects.toThrow(MEMORY_SHARED_LAYER_NEEDS_PERSON)
      // Reading the shared layer and writing the conversation's own stay open.
      expect(await w.tool({ mode: 'read', layer: 'shared' })).toEqual({ agentId: AGENT })
      expect(await w.tool({ mode: 'write' })).not.toEqual({ agentId: AGENT })
    }
  })

  it("takes it on a person's own turn in the same place, or one a person's message folded into", async () => {
    const w = world({ snapshot: { isPrivate: true } })
    w.turn(TYPED)
    expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
    w.turn(ROUNDS.report, [TYPED])
    expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
  })

  it.each<[string, Place]>([
    ['a Slack Connect channel', { snapshot: { isPrivate: false, externalReason: 'externallyShared' } }],
    ['a public channel with a known guest', { snapshot: PUBLIC, external: true }],
    ['a private channel with a known guest', { snapshot: { isPrivate: true }, external: true }],
    ['a group DM with a known guest', { channel: 'G1', conversationKind: 'group_dm', external: true }]
  ])("refuses it in %s on every round, a guest's own turn included", async (_, place) => {
    const w = world(place)
    for (const msg of [{ ...TYPED, sender: { id: 'U-GUEST', isBot: false } }, ...Object.values(ROUNDS)]) {
      w.turn(msg)
      await expect(w.tool({ mode: 'write', layer: 'shared' })).rejects.toThrow(MEMORY_SHARED_LAYER_EXTERNAL)
      expect(await w.tool({ mode: 'write' })).toMatchObject({ channelKey: memoryChannelKey(w.ctx.channel) })
    }
    // An internal member's own turn in a private channel with no outsiders still may.
    const internal = world({ snapshot: { isPrivate: true } })
    internal.turn(TYPED)
    expect(await internal.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
  })

  it("leaves a public internal channel's rounds as they were", async () => {
    const w = world({ snapshot: PUBLIC })
    for (const msg of [TYPED, ...Object.values(ROUNDS)]) {
      w.turn(msg)
      expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
      expect(await w.tool({ mode: 'write' })).toMatchObject({ sharedPlace: true })
    }
  })
})

describe('the retired memory scope setting', () => {
  it('no longer changes routing: a public channel shares even for an agent that chose Channel', async () => {
    for (const scope of ['agent', 'channel'] as const) {
      const w = world({ snapshot: PUBLIC }, { scope })
      expect(await w.tool({ mode: 'write' })).toMatchObject({ sharedPlace: true })
      expect(await w.captured()).toMatchObject({ sharedPlace: true })
    }
  })
})

describe('dreams mine only conversations of the shared layer, for every agent', () => {
  it('lists only shared channels as open for an agent outside assistant mode', async () => {
    const w = world({ snapshot: PUBLIC })
    const rows = [
      { platform: 'slack', channel: 'C1', conversationKind: 'channel' },
      { platform: 'slack', channel: 'C2', conversationKind: 'channel' },
      { platform: 'slack', channel: 'D1', conversationKind: 'dm' },
      { platform: 'slack', channel: 'G1', conversationKind: 'group_dm' },
      { platform: 'telegram', channel: '-1001', conversationKind: 'channel' },
      { platform: 'webchat', channel: 'conv-1', conversationKind: null }
    ].map((r, i) => ({ ...r, key: `k${i}`, agentId: AGENT, thread: THREAD, updatedAt: i }))
    w.daemon.store.listSessions = vi.fn(async () => rows)
    w.daemon.channelSnapshots.set('int-1', {
      channels: [
        { id: 'C1', ...PUBLIC },
        { id: 'C2', isPrivate: true }
      ],
      authoritative: true
    })
    w.daemon.channelSnapshots.set('int-2', { channels: [{ id: '-1001', isPrivate: false }], authoritative: true })
    const places = await w.daemon.dreamPlaces(AGENT)
    expect(places.open).toEqual(['C1'])
    expect(places.platforms).toEqual(expect.arrayContaining(['slack', 'telegram', 'webchat']))
  })
})

describe('an automated turn never names the person a DM is with', () => {
  const check = { source: 'agent', sender: { id: AGENT_UUID, isBot: false }, isDm: false }

  it("gives check sessions in two people's DMs those two people's layers, not one key", async () => {
    const one = world({
      channel: 'D1',
      conversationKind: 'dm',
      triggeredBy: AGENT_UUID,
      lookup: { isIm: true, user: 'U1' }
    })
    const two = world({
      channel: 'D2',
      conversationKind: 'dm',
      triggeredBy: AGENT_UUID,
      lookup: { isIm: true, user: 'U2' }
    })
    expect(await one.captured(check)).toMatchObject({ personKey: memoryPersonKey(`slack:${TENANT}:U1`) })
    expect(await two.captured(check)).toMatchObject({ personKey: memoryPersonKey(`slack:${TENANT}:U2`) })
    expect(await one.tool({ mode: 'write' })).toEqual({
      agentId: AGENT,
      personKey: memoryPersonKey(`slack:${TENANT}:U1`)
    })
  })

  it('keeps each DM to itself when nothing names its person', async () => {
    const one = world({ channel: 'D1', conversationKind: 'dm', triggeredBy: AGENT_UUID })
    const two = world({ channel: 'D2', conversationKind: 'dm', triggeredBy: AGENT_UUID })
    const a = await one.captured(check)
    const b = await two.captured(check)
    expect(a).toMatchObject({ channelKey: memoryChannelKey('D1') })
    expect(b).toMatchObject({ channelKey: memoryChannelKey('D2') })
    expect(a).not.toHaveProperty('personKey')
  })

  it('resolves the same layer at session start and at the tool calls that follow', async () => {
    const w = world({
      channel: 'D1',
      conversationKind: 'dm',
      triggeredBy: AGENT_UUID,
      lookup: { isIm: true, user: 'U1' }
    })
    const atStart = await w.start(check)
    expect(atStart).toEqual({ agentId: AGENT, personKey: memoryPersonKey(`slack:${TENANT}:U1`) })
    expect(await w.tool({ mode: 'write' })).toEqual(atStart)
    expect(await w.captured(check)).toMatchObject(atStart)
  })

  it('names the person from the message they typed, whoever opened the session', async () => {
    const w = world({ channel: 'D1', conversationKind: 'dm', triggeredBy: AGENT_UUID })
    const typed = { source: 'user', sender: { id: 'U1', isBot: false }, isDm: true }
    expect(await w.captured(typed)).toMatchObject({ personKey: memoryPersonKey(`slack:${TENANT}:U1`) })
  })
})

describe('a channel shares only where the platform confirms it is not shared', () => {
  it('keeps a channel the lookup reports shared with another organization to itself', async () => {
    const w = world({ lookup: { isPrivate: false, externalReason: 'externallyShared' } })
    const scope = await w.captured()
    expect(scope).toMatchObject({ channelKey: memoryChannelKey('C1') })
    expect(scope).not.toHaveProperty('sharedPlace')
  })

  it('shares a public channel the lookup confirms internal', async () => {
    expect(await world({ lookup: { isPrivate: false, externalReason: null } }).captured()).toMatchObject({
      sharedPlace: true
    })
  })

  it('keeps a channel to itself when the lookup fails or never says whether it is shared', async () => {
    for (const lookup of [new Error('ratelimited'), { isPrivate: false }]) {
      const scope = await world({ lookup }).captured()
      expect(scope).toMatchObject({ channelKey: memoryChannelKey('C1') })
      expect(scope).not.toHaveProperty('sharedPlace')
    }
  })
})

describe('a memory write names the layer it landed in', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })

  // The daemon's own scope rule over a real managed tree, so the layer a result names is where the file is.
  async function writer(place: Place) {
    const w = world(place)
    const dir = await mkdtemp(join(tmpdir(), 'memory-written-layer-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const db = await openTestStore(join(dir, 'state.sqlite'))
    cleanup.push(() => db.close())
    const deps = {
      memory: new ManagedMemoryProvider(() => localMemoryHome(new LocalMemoryFs(join(dir, 'agent')))),
      memoryEntryStore: db,
      memoryScope: (ctx: SessionContext, call: MemoryToolCall) => w.daemon.memoryToolScope(ctx, call)
    } as unknown as OpsDeps
    const write = async (name: string, args: Record<string, unknown>) =>
      (await executeTool(w.ctx, name, args, deps)) as Record<string, unknown>
    return { write, turn: w.turn, landed: (path: string) => existsSync(join(dir, 'agent', path)) }
  }
  const DM: Place = { channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }
  const PERSON_DIR = `people/${memoryPersonKey(`slack:${TENANT}:U1`)}/memory`

  it("names the person's own layer for a 1:1 DM write with no layer", async () => {
    const { write, landed } = await writer(DM)
    expect(await write('writeMemory', { path: 'prefs.md', content: '- tabs' })).toMatchObject({
      ok: true,
      path: 'prefs.md',
      layer: 'person',
      note: MEMORY_LAYER_NOTES.person
    })
    expect(landed(`${PERSON_DIR}/prefs.md`)).toBe(true)
  })

  it("names this conversation's own layer in a channel with several people", async () => {
    const { write, landed } = await writer({ snapshot: { isPrivate: true } })
    expect(await write('writeMemory', { path: 'prefs.md', content: '- tabs' })).toMatchObject({
      layer: 'here',
      note: MEMORY_LAYER_NOTES.here
    })
    expect(landed(`channels/${memoryChannelKey('C1')}/memory/prefs.md`)).toBe(true)
  })

  it('names the shared layer when asked for everyone, and where the conversation itself shares', async () => {
    const dm = await writer(DM)
    dm.turn({ ...TYPED, isDm: true })
    expect(await dm.write('writeMemory', { path: 'prefs.md', content: '- tabs', layer: 'shared' })).toMatchObject({
      layer: 'shared',
      note: MEMORY_LAYER_NOTES.shared
    })
    expect(dm.landed('memory/prefs.md')).toBe(true)
    // A public internal channel writes the shared layer even when asked for `here`, and says so.
    const open = await writer({ snapshot: PUBLIC })
    expect(await open.write('writeMemory', { path: 'a.md', content: 'x' })).toMatchObject({ layer: 'shared' })
    expect(await open.write('writeMemory', { path: 'b.md', content: 'x', layer: 'here' })).toMatchObject({
      layer: 'shared'
    })
    expect(open.landed('memory/b.md')).toBe(true)
  })

  it('names the layer of an edit and of a deletion, for files and entries alike', async () => {
    const { write, landed } = await writer(DM)
    await write('writeMemory', { path: 'prefs.md', content: 'keep\nDROP\n' })
    expect(await write('writeMemory', { path: 'prefs.md', oldString: 'keep', newString: 'kept' })).toMatchObject({
      layer: 'person'
    })
    expect(await write('writeMemory', { path: 'prefs.md', oldString: 'DROP\n', newString: '' })).toMatchObject({
      layer: 'person'
    })
    const created = await write('createMemoryEntry', { label: 'tz', text: 'UTC+8' })
    expect(created).toMatchObject({ state: 'completed', layer: 'person', note: MEMORY_LAYER_NOTES.person })
    expect(landed(`${PERSON_DIR}/tz.md`)).toBe(true)
    const { entry } = created as MemoryEntryMutationReceipt
    const updated = await write('updateMemoryEntry', { ref: entry!.ref, revision: entry!.revision, text: 'UTC+9' })
    expect(updated).toMatchObject({ state: 'completed', layer: 'person' })
    const { entry: next } = updated as MemoryEntryMutationReceipt
    expect(await write('deleteMemoryEntry', { ref: next!.ref, revision: next!.revision })).toMatchObject({
      state: 'completed',
      layer: 'person',
      note: MEMORY_LAYER_NOTES.person
    })
    expect(landed(`${PERSON_DIR}/tz.md`)).toBe(false)
  })
})

// assistant-mode.md §5.17: the people directory is written through the same tools, under its person rules.
describe('the people directory, members.md in the shared layer', () => {
  const cleanup: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  const key = (uid: string) => `slack:${TENANT}:${uid}`
  const head = '---\nname: members\ndescription: who works on what\n---\n# Members\n'
  const entry = (name: string, uid: string, line: string) =>
    `## ${name} (@${name.toLowerCase()} on Slack) \`${key(uid)}\`\n${line}\n`

  async function tree() {
    const dir = await mkdtemp(join(tmpdir(), 'memory-members-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const db = await openTestStore(join(dir, 'state.sqlite'))
    cleanup.push(() => db.close())
    return { dir, db }
  }

  // The daemon's own scope and directory rules over a real managed tree, with U1–U3 full members of the workspace.
  async function session(place: Place, at: { dir: string; db: unknown }) {
    const w = world(place)
    const home = localMemoryHome(new LocalMemoryFs(join(at.dir, 'agent')))
    w.daemon.memoryHomePortsFor = () => home
    w.daemon.store.getDisplayNames = async () => new Map([[w.ctx.channel, 'release-train']])
    const members = new Set(['U1', 'U2', 'U3'])
    w.daemon.placeMembers = {
      isFullMember: async (_int: string, uid: string) => members.has(uid),
      consoleVerdict: async () => ({ asker: 'unidentifiable' })
    }
    const deps = {
      memory: new ManagedMemoryProvider(() => home),
      memoryEntryStore: at.db,
      memoryScope: (ctx: SessionContext, call: MemoryToolCall) => w.daemon.memoryToolScope(ctx, call),
      membersGuard: (ctx: SessionContext, scope: unknown) => w.daemon.membersGuard(ctx, scope)
    } as unknown as OpsDeps
    const run = async (name: string, args: Record<string, unknown>) =>
      (await executeTool(w.ctx, name, args, deps)) as Record<string, unknown>
    const read = () => readFile(join(at.dir, 'agent', 'memory', 'members.md'), 'utf8').catch(() => null)
    return { ...w, run, read }
  }
  const TYPED_WITH_BOB = { ...TYPED, mentionedUsers: ['U2'] }

  it('writes what a person states of themselves and of someone they mention, on their turn', async () => {
    const at = await tree()
    const s = await session({ snapshot: PUBLIC }, at)
    s.turn(TYPED_WITH_BOB)
    const text = [
      head,
      entry('Alice', 'U1', 'Role: release manager (self, 2026-10-17)'),
      entry('Bob', 'U2', 'Works on: billing (#release-train, 2026-10-17)')
    ].join('\n')
    expect(await s.run('createMemoryEntry', { label: 'members', text })).toMatchObject({
      state: 'completed',
      layer: 'shared'
    })
    expect(await s.read()).toContain('Role: release manager (self, 2026-10-17)')
  })

  it('refuses an entry about someone not on the turn, a round no person typed, and a whole-file write', async () => {
    const at = await tree()
    const s = await session({ snapshot: PUBLIC }, at)
    s.turn(TYPED)
    const carol = [head, entry('Carol', 'U3', 'Works on: docs (#release-train, 2026-10-17)')].join('\n')
    await expect(s.run('createMemoryEntry', { label: 'members', text: carol })).rejects.toThrow('not on this turn')
    s.turn(ROUNDS.report)
    const alice = [head, entry('Alice', 'U1', 'Role: x (self, 2026-10-17)')].join('\n')
    await expect(s.run('createMemoryEntry', { label: 'members', text: alice })).rejects.toThrow('a turn a person typed')
    s.turn(TYPED)
    await expect(s.run('writeMemory', { path: 'members.md', content: alice })).rejects.toThrow(
      MEMBERS_FILE_ENTRY_TOOLS_ONLY
    )
    expect(await s.read()).toBeNull()
    // Any other shared file is untouched by the directory's rules.
    expect(await s.run('createMemoryEntry', { label: 'deploys', text: '- Fridays' })).toMatchObject({
      state: 'completed'
    })
  })

  it('lets a person change only their own entry from their DM, and forgetting them keeps them out', async () => {
    const at = await tree()
    const channel = await session({ snapshot: PUBLIC }, at)
    channel.turn(TYPED_WITH_BOB)
    const bob = entry('Bob', 'U2', 'Works on: billing (#release-train, 2026-10-01)')
    const both = [head, entry('Alice', 'U1', 'Role: x (self, 2026-10-01)'), bob].join('\n')
    await channel.run('createMemoryEntry', { label: 'members', text: both })
    const dm = await session({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' }, at)
    dm.turn({ ...TYPED, isDm: true })
    const shared = (await dm.run('listMemoryEntries', { layer: 'shared' })) as {
      entries: { ref: string; revision: string; label: string }[]
    }
    const { ref, revision } = shared.entries.find((e) => e.label === 'members')!
    // Bob's entry is not theirs to change.
    await expect(
      dm.run('updateMemoryEntry', { ref, revision, text: both.replace('billing', 'payments'), layer: 'shared' })
    ).rejects.toThrow('only your own entry')
    // "Forget me": their entry goes, and they are marked out by the key they are known by.
    const withoutAlice = [head, bob].join('\n')
    await dm.run('updateMemoryEntry', { ref, revision, text: withoutAlice, layer: 'shared' })
    const marker = JSON.parse(await readFile(join(at.dir, 'agent', 'people', '.directory-opt-out.json'), 'utf8'))
    expect(Object.keys(marker.keys)).toEqual([key('U1')])
    // A channel can no longer write about them, even on their own turn.
    channel.turn(TYPED)
    const listed = (await channel.run('listMemoryEntries', {})) as {
      entries: { ref: string; revision: string; label: string }[]
    }
    const members = listed.entries.find((e) => e.label === 'members')!
    await expect(
      channel.run('updateMemoryEntry', {
        ref: members.ref,
        revision: members.revision,
        text: [withoutAlice, entry('Alice', 'U1', 'Role: x (self, 2026-10-17)')].join('\n')
      })
    ).rejects.toThrow('cleared their entry')
  })

  it('takes a first look as a builder, with no turn to be on', async () => {
    const s = world({ snapshot: PUBLIC })
    expect(await s.daemon.membersWriter({ ...s.ctx, thread: firstLookCoordinate('d-1') })).toEqual({
      kind: 'builder'
    })
  })
})
