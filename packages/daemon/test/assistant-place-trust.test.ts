// A place turning external (assistant-mode.md §5.3): for every agent it reads external at once and reaches the CP, and no turn is cut.
import { describe, expect, it, vi } from 'vitest'
import { mergePlaceExternalReason, type IntegrationChannel, type PlaceExternalReason } from '@agentconnect.md/protocol'
import { PLACE_SHARE_TTL_MS, PlaceTrust, type PlaceTrustDeps } from '../src/assistant/place-trust.js'
import { Daemon } from '../src/daemon.js'
import { conversationTrustLevel } from '../src/router/routing-rule.js'
import type { Integration } from '../src/agents/agent-schema.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const integrationOf = (id: string, externalChannels: string[] = [], mode: 'direct' | 'shared' = 'direct') =>
  ({
    id,
    platform: 'slack',
    core: { mode, bindRules: [], mutedChannels: [], gated: true, externalChannels }
  }) as unknown as Integration

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A PlaceTrust over fakes: the integrations it knows, what each lists external, and the platform's share lookup. */
function world(
  ids: string[],
  external: Record<string, string[]> = {},
  lookup?: (channel: string) => Promise<PlaceExternalReason | null>
) {
  const integrations = new Map(ids.map((id) => [id, integrationOf(id, external[id])]))
  const reports: [string, IntegrationChannel][] = []
  const clock = { now: 1_000 }
  const deps: PlaceTrustDeps = {
    integration: (id) => integrations.get(id),
    report: (id, channel) => void reports.push([id, channel]),
    now: () => clock.now,
    shareLookup: () => lookup
  }
  return { trust: new PlaceTrust(deps), integrations, reports, clock }
}

describe('PlaceTrust', () => {
  it('marks an internal place external for every agent and reports it once', async () => {
    const w = world(['int-a', 'int-b'])
    w.trust.detected(['int-a', 'int-b'], 'C1', 'guestMember')
    w.trust.detected(['int-a', 'int-b'], 'C1', 'externallyShared')
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('external')
    expect(conversationTrustLevel(w.integrations.get('int-b')!, 'C1')).toBe('external')
    expect(w.reports).toEqual([
      ['int-a', { id: 'C1', externalReason: 'guestMember' }],
      ['int-b', { id: 'C1', externalReason: 'guestMember' }]
    ])
  })

  it('reports a guest in an already shared place so it turns sticky', async () => {
    const w = world(['int-a'], { 'int-a': ['C1'] })
    w.trust.detected(['int-a'], 'C1', 'guestMember')
    await settle()
    expect(w.reports).toEqual([['int-a', { id: 'C1', externalReason: 'guestMember' }]])
  })

  it('takes the share flag of a room or group DM message, never of a 1:1 DM', async () => {
    const w = world(['int-a'])
    w.trust.observe({ channel: 'D1', isDm: true, externallyShared: true }, ['int-a'])
    w.trust.observe({ channel: 'C2', isDm: false }, ['int-a'])
    w.trust.observe({ channel: 'G1', isDm: false, isGroupDm: true, externallyShared: true }, ['int-a'])
    w.trust.observe({ channel: 'C1', isDm: false, externallyShared: true }, ['int-a'])
    await settle()
    expect(w.reports.map(([, channel]) => channel)).toEqual([
      { id: 'G1', externalReason: 'externallyShared' },
      { id: 'C1', externalReason: 'externallyShared' }
    ])
  })

  it('holds a place the spec newly lists on the live integration until it reconciles', async () => {
    const w = world(['int-a', 'int-b'])
    w.trust.specApplied('int-a', integrationOf('int-a', ['C1']), ['C1'])
    w.trust.specApplied('int-b', integrationOf('int-b', ['C1']), ['C1'])
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('external')
    expect(conversationTrustLevel(w.integrations.get('int-b')!, 'C1')).toBe('external')
    expect(w.reports).toEqual([])
  })

  // A detection the CP has not confirmed must survive a spec, a listing and a reconnect, or the place reads internal again.
  it('holds a share across specs and replays until a spec lists it, and a guest even after', async () => {
    const w = world(['int-a'])
    w.trust.detected(['int-a'], 'C1', 'externallyShared')
    w.trust.detected(['int-a'], 'C2', 'guestMember')
    const stale = integrationOf('int-a')
    w.trust.specApplied('int-a', stale, [])
    expect(conversationTrustLevel(stale, 'C1')).toBe('external')
    expect(conversationTrustLevel(stale, 'C2')).toBe('external')
    expect(w.trust.replayRows('int-a', [])).toEqual([
      { id: 'C1', externalReason: 'externallyShared' },
      { id: 'C2', externalReason: 'guestMember' }
    ])
    // A spec lists the set, not the reason: it takes over the share, never the guest.
    w.trust.specApplied('int-a', integrationOf('int-a', ['C1', 'C2']), [])
    expect(w.trust.replayRows('int-a', [{ id: 'C1', externalReason: null }])).toEqual([
      { id: 'C1', externalReason: null },
      { id: 'C2', externalReason: 'guestMember' }
    ])
  })

  it('drops a held guest only for a channel a complete listing no longer has', () => {
    const w = world(['int-a'])
    w.trust.detected(['int-a'], 'C1', 'guestMember')
    w.trust.detected(['int-a'], 'C9', 'externalMember')
    expect(w.trust.listed('int-a', [{ id: 'C1', externalReason: null }])).toEqual([
      { id: 'C1', externalReason: 'guestMember' }
    ])
    expect(w.trust.replayRows('int-a', [])).toEqual([{ id: 'C1', externalReason: 'guestMember' }])
  })

  it('lets a listing lift a held share but never a held guest, and carries what it keeps', () => {
    const w = world(['int-a'])
    w.trust.detected(['int-a'], 'C1', 'externallyShared')
    w.trust.detected(['int-a'], 'C2', 'guestMember')
    const listing = [
      { id: 'C1', externalReason: null },
      { id: 'C2', externalReason: null },
      { id: 'C3', externalReason: null }
    ]
    expect(w.trust.listed('int-a', listing)).toEqual([
      { id: 'C1', externalReason: null },
      { id: 'C2', externalReason: 'guestMember' },
      { id: 'C3', externalReason: null }
    ])
    expect(w.trust.replayRows('int-a', [])).toEqual([{ id: 'C2', externalReason: 'guestMember' }])
    w.trust.forget('int-a')
    expect(w.trust.heldIntegrations()).toEqual([])
  })

  it('watches member joins on every agent’s integration, whatever its mode, and on no unknown one', () => {
    const w = world(['int-a', 'int-b'])
    expect(w.trust.watches(['int-b'])).toBe(true)
    expect(w.trust.watches(['int-a'])).toBe(true)
    expect(w.trust.watches(['int-gone'])).toBe(false)
    expect(w.trust.watches([])).toBe(false)
  })
})

// A place learns of a share from its next event, so a post no event triggered asks the platform first (§5.3).
describe('PlaceTrust.confirm', () => {
  it('answers repeated posts from one lookup per place, and asks again once the answer is a minute old', async () => {
    const lookup = vi.fn(async () => null)
    const w = world(['int-a'], {}, lookup)
    expect(await Promise.all([w.trust.confirm('int-a', 'C1'), w.trust.confirm('int-a', 'C1')])).toEqual([
      'internal',
      'internal'
    ])
    w.clock.now += PLACE_SHARE_TTL_MS - 1
    expect(await w.trust.confirm('int-a', 'C1')).toBe('internal')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(await w.trust.confirm('int-a', 'C2')).toBe('internal')
    w.clock.now += 1
    expect(await w.trust.confirm('int-a', 'C1')).toBe('internal')
    expect(lookup.mock.calls).toEqual([['C1'], ['C2'], ['C1']])
    expect(w.reports).toEqual([])
  })

  it('makes a share it finds the same detection an event makes', async () => {
    let answer!: (reason: PlaceExternalReason | null) => void
    const lookup = vi.fn(() => new Promise<PlaceExternalReason | null>((resolve) => (answer = resolve)))
    const w = world(['int-a'], {}, lookup)
    const asked = [w.trust.confirm('int-a', 'C1'), w.trust.confirm('int-a', 'C1')]
    answer('externallyShared')
    expect(await Promise.all(asked)).toEqual(['external', 'external'])
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('external')
    expect(w.reports).toEqual([['int-a', { id: 'C1', externalReason: 'externallyShared' }]])
    // Known now: later posts read it from the spec, with no lookup and no second report.
    w.clock.now += PLACE_SHARE_TTL_MS
    expect(await w.trust.confirm('int-a', 'C1')).toBe('external')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(w.reports).toHaveLength(1)
  })

  it('answers unknown when the lookup fails, marking nothing, and asks again on the next post', async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new Error('ratelimited')).mockResolvedValueOnce(null)
    const w = world(['int-a'], {}, lookup)
    expect(await w.trust.confirm('int-a', 'C1')).toBe('unknown')
    await settle()
    expect(conversationTrustLevel(w.integrations.get('int-a')!, 'C1')).toBe('internal')
    expect(w.reports).toEqual([])
    expect(await w.trust.confirm('int-a', 'C1')).toBe('internal')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('asks nothing of a platform that reports no share, nor about a place already known external', async () => {
    const lookup = vi.fn(async () => null)
    expect(await world(['int-a']).trust.confirm('int-a', 'C1')).toBe('internal')
    expect(await world(['int-a'], { 'int-a': ['C1'] }, lookup).trust.confirm('int-a', 'C1')).toBe('external')
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('a place turning external in the daemon', () => {
  /** An assistant-mode agent and a plain one, with turns in flight across places. */
  function daemonWorld() {
    const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
    daemon.agents.set('bot-a', {
      id: 'bot-a',
      integrations: [integrationOf('int-a', [], 'shared')],
      assistantMode: { enabled: true }
    })
    daemon.agents.set('bot-b', { id: 'bot-b', integrations: [integrationOf('int-b', [], 'shared')] })
    const entry = (agentId: string, integrationId: string, channel: string, extra: object = {}) => ({
      agentId,
      integrationId,
      msg: { channel, ...extra }
    })
    daemon.activeGateEntries.set('a-c1', entry('bot-a', 'int-a', 'C1'))
    daemon.activeGateEntries.set('a-c2', entry('bot-a', 'int-a', 'C2'))
    daemon.activeGateEntries.set('a-c1-cron', entry('bot-a', 'int-a', 'C1', { headless: true }))
    daemon.activeGateEntries.set('b-c1', entry('bot-b', 'int-b', 'C1'))
    daemon.interruptTurn = vi.fn(async () => {})
    daemon.cpClient = { emitIntegrationChannels: vi.fn() }
    daemon.store = { retractedIntegrations: async () => [], retractedConversations: async () => [] }
    return daemon
  }

  /** What a CP reconnect replays for the integration. */
  async function replayed(daemon: any): Promise<unknown[]> {
    daemon.cpClient = { emitIntegrationChannels: vi.fn() }
    await daemon.replayChannelSnapshots()
    return daemon.cpClient.emitIntegrationChannels.mock.calls.map(([report]: [unknown]) => report)
  }

  it('records the place for every agent and cuts no turn in it, in assistant mode or not', async () => {
    const daemon = daemonWorld()
    daemon.placeTrust.detected(['int-a', 'int-b'], 'C1', 'guestMember')
    await settle()
    expect(daemon.interruptTurn).not.toHaveBeenCalled()
    expect(daemon.cpClient.emitIntegrationChannels.mock.calls).toEqual([
      [{ integrationId: 'int-a', channels: [{ id: 'C1', externalReason: 'guestMember' }], authoritative: false }],
      [{ integrationId: 'int-b', channels: [{ id: 'C1', externalReason: 'guestMember' }], authoritative: false }]
    ])
  })

  it('replays a guest found before any listing, while the CP was away', async () => {
    const daemon = daemonWorld()
    daemon.cpClient = undefined
    daemon.placeTrust.detected(['int-a'], 'C1', 'guestMember')
    expect(await replayed(daemon)).toEqual([
      { integrationId: 'int-a', channels: [{ id: 'C1', externalReason: 'guestMember' }], authoritative: false }
    ])
  })

  it('keeps a detection made while the CP was away through a listing that rebuilt the cache, and replays it', async () => {
    const daemon = daemonWorld()
    daemon.cpClient = undefined
    daemon.placeTrust.detected(['int-a'], 'C1', 'guestMember')
    daemon.placeTrust.detected(['int-a'], 'G1', 'externallyShared')
    const conn = {
      botUserId: 'UBOT',
      listBotChannels: async () => [
        { id: 'C1', externalReason: null },
        { id: 'C2', externalReason: null }
      ]
    }
    daemon.connByIntegration.set('int-a', conn)
    await daemon.connections.refreshChannels(conn)
    expect(await replayed(daemon)).toEqual([
      {
        integrationId: 'int-a',
        channels: [
          { id: 'C1', externalReason: 'guestMember' },
          { id: 'C2', externalReason: null },
          { id: 'G1', externalReason: 'externallyShared' }
        ]
      }
    ])
    // Once the CP's spec lists them, nothing is held: the replay is the cached listing, which already carried the guest.
    daemon.placeTrust.specApplied('int-a', integrationOf('int-a', ['C1', 'G1'], 'shared'), [])
    expect(await replayed(daemon)).toEqual([
      {
        integrationId: 'int-a',
        channels: [
          { id: 'C1', externalReason: 'guestMember' },
          { id: 'C2', externalReason: null }
        ]
      }
    ])
  })

  // A guest found in an already shared channel while the CP was away: the reconnect's unchanged spec lists the channel,
  // which says nothing of the guest, so the guest is still replayed and an unshare later cannot lift it.
  it('replays a guest in an already shared channel past an unchanged spec, so a later unshare keeps it external', async () => {
    const daemon = daemonWorld()
    const live = daemon.agents.get('bot-a').integrations[0]
    live.core.externalChannels = ['C1']
    daemon.channelSnapshots.set('int-a', {
      channels: [{ id: 'C1', externalReason: 'externallyShared' }],
      authoritative: true
    })
    daemon.cpClient = undefined
    daemon.placeTrust.detected(['int-a'], 'C1', 'guestMember')
    await settle()
    expect(daemon.interruptTurn).not.toHaveBeenCalled()

    // Reconnect: the CP re-sends the spec it has, which lists C1 for the share alone.
    daemon.placeTrust.specApplied('int-a', integrationOf('int-a', ['C1'], 'shared'), [])
    expect(await replayed(daemon)).toEqual([
      { integrationId: 'int-a', channels: [{ id: 'C1', externalReason: 'guestMember' }] }
    ])

    // Slack stops sharing C1: the listing's null reaches the CP carrying the guest, which no report lifts.
    const conn = { botUserId: 'UBOT', listBotChannels: async () => [{ id: 'C1', externalReason: null }] }
    daemon.connByIntegration.set('int-a', conn)
    await daemon.connections.refreshChannels(conn)
    const sent = daemon.cpClient.emitIntegrationChannels.mock.calls.at(-1)[0]
    expect(sent).toEqual({ integrationId: 'int-a', channels: [{ id: 'C1', externalReason: 'guestMember' }] })
    expect(mergePlaceExternalReason('guestMember', sent.channels[0].externalReason)).toBe('guestMember')
    expect(await replayed(daemon)).toEqual([
      { integrationId: 'int-a', channels: [{ id: 'C1', externalReason: 'guestMember' }] }
    ])
  })

  it('looks up a member the relay forwarded for every agent, cutting no turn', async () => {
    const daemon = daemonWorld()
    const joinedMemberReason = vi.fn(async () => 'guestMember')
    daemon.connByIntegration.set('int-a', { joinedMemberReason })
    daemon.connByIntegration.set('int-b', { joinedMemberReason })
    const join = (agentId: string, integrationId: string) =>
      daemon.handleRelaySlackAction({
        agentId,
        integrationId,
        sessionKey: 'slack:C1',
        msgId: `m-${agentId}`,
        botId: 'bot-1',
        userId: 'UGUEST',
        payload: { kind: 'member-joined', channelId: 'C1', userId: 'UGUEST' }
      })
    expect(await join('bot-b', 'int-b')).toEqual({ msgId: 'm-bot-b', accepted: true })
    await settle()
    expect(joinedMemberReason).toHaveBeenCalledWith('UGUEST', false)
    expect(conversationTrustLevel(daemon.agents.get('bot-b').integrations[0], 'C1')).toBe('external')
    expect(daemon.cpClient.emitIntegrationChannels).toHaveBeenCalledWith({
      integrationId: 'int-b',
      channels: [{ id: 'C1', externalReason: 'guestMember' }],
      authoritative: false
    })
    expect(daemon.interruptTurn).not.toHaveBeenCalled()
    expect(await join('bot-a', 'int-a')).toEqual({ msgId: 'm-bot-a', accepted: true })
    await settle()
    expect(joinedMemberReason).toHaveBeenCalledTimes(2)
    expect(conversationTrustLevel(daemon.agents.get('bot-a').integrations[0], 'C1')).toBe('external')
    expect(daemon.interruptTurn).not.toHaveBeenCalled()
  })
})
