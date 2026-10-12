// Every agent's capture, memory tools and dreams follow the conversation's layer (unified-memory-interface.md §6).
import { describe, expect, it, vi } from 'vitest'
import type { IntegrationChannel } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { SessionContext } from '../src/mcp/ops.js'
import { memoryChannelKey, memoryPersonKey } from '../src/memory/store.js'
import { MEMORY_PERSON_LAYER_REFUSED, MEMORY_SHARED_LAYER_ONLY } from '../src/memory/tools.js'
import { sessionKey } from '../src/store/local-store.js'
import { appendCoordinate } from '../src/session/append-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
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
    ...(agent.assistant ? { assistantMode: { enabled: true, responsibleUserId: 'user-1' } } : {})
  })
  if (place.snapshot) {
    const integrationId = platform === 'telegram' ? 'int-2' : 'int-1'
    daemon.channelSnapshots.set(integrationId, { channels: [{ id: channel, ...place.snapshot }], authoritative: true })
  }
  daemon.tenantScopeForIntegration = async () => TENANT
  daemon.linkedConsoleUser = async (_agent: string, _int: string, member: string) => agent.linked?.[member]
  const captured = async (): Promise<unknown> => {
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
      { key, outwardSessionId: 'outward-1' }
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
  return { daemon, captured, tool, ctx }
}

const PUBLIC = { isPrivate: false, externalReason: null }

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
    await expect(w.tool({ mode: 'write' })).rejects.toThrow(MEMORY_SHARED_LAYER_ONLY)
    expect(await w.tool({ mode: 'read' })).toEqual({ agentId: AGENT })
    expect(await w.tool({ mode: 'write', layer: 'shared' })).toEqual({ agentId: AGENT })
  })
})

describe("explicit memory tools: the session's layer, or the one `layer` names", () => {
  it('writes a DM to the person layer with no card, and to the shared layer when asked for everyone', async () => {
    const w = world({ channel: 'D1', conversationKind: 'dm', triggeredBy: 'U1' })
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
