import { describe, expect, it } from 'vitest'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'
import type { GameTopologyManifest } from '../games/types.js'

const manifest: GameTopologyManifest = {
  game: 'authorization-fixture',
  seed: 11,
  agents: [{ id: 'member-agent' }, { id: 'outsider-agent' }, { id: 'observer-agent' }],
  rooms: [
    { id: 'main-room', platform: 'slack', members: ['member-agent'], observers: ['observer-agent'] },
    { id: 'other-room', platform: 'slack', members: ['outsider-agent', 'observer-agent'] }
  ]
}

function fixture() {
  const topology = compileTopology(manifest)
  const world = new ArenaWorld(topology)
  const integration = (alias: string) => topology.integrations.find((i) => i.alias === alias)!
  const room = (alias: string) => topology.rooms.find((r) => r.alias === alias)!
  return { topology, world, integration, room }
}

describe('world outbound authorization (§7.2) — enforced, not recorded', () => {
  it('delivers an authorized member reply with a monotonic sequence', async () => {
    const { world, integration, room } = fixture()
    const member = integration('member-agent/slack')
    const first = await world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: member.integrationId,
      channel: room('main-room').channel,
      thread: room('main-room').thread,
      identity: { agentAuthorId: member.agentId },
      text: '1'
    })
    const second = await world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: member.integrationId,
      channel: room('main-room').channel,
      text: 'root post'
    })
    expect(first.status).toBe('delivered')
    expect(second.status).toBe('delivered')
    expect(second.sequence).toBeGreaterThan(first.sequence)
  })

  it.each([
    [
      'unknown integration',
      'integration_not_owned',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: 'not-a-real-integration',
        channel: f.room('main-room').channel
      })
    ],
    [
      'forged sender identity',
      'integration_not_owned',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: f.integration('member-agent/slack').integrationId,
        channel: f.room('main-room').channel,
        identity: { agentAuthorId: f.integration('outsider-agent/slack').agentId }
      })
    ],
    [
      'wrong platform',
      'platform_mismatch',
      (f: ReturnType<typeof fixture>) => ({
        platform: 'discord' as const,
        integrationId: f.integration('member-agent/slack').integrationId,
        channel: f.room('main-room').channel
      })
    ],
    [
      'unknown channel',
      'unknown_channel',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: f.integration('member-agent/slack').integrationId,
        channel: 'CDOESNOTEXIST'
      })
    ],
    [
      'invisible channel',
      'channel_not_visible',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: f.integration('member-agent/slack').integrationId,
        channel: f.room('other-room').channel
      })
    ],
    [
      'visible but not a member',
      'not_a_member',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: f.integration('observer-agent/slack').integrationId,
        channel: f.room('main-room').channel
      })
    ],
    [
      'nonexistent thread',
      'invalid_thread',
      (f: ReturnType<typeof fixture>) => ({
        integrationId: f.integration('member-agent/slack').integrationId,
        channel: f.room('main-room').channel,
        thread: '999999.000000'
      })
    ]
  ])('rejects %s as %s and still records the attempt', async (_label, reason, build) => {
    const f = fixture()
    const result = await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      text: 'attempt',
      ...build(f)
    })
    expect(result).toMatchObject({ status: 'rejected', reason })
    // Every attempt — delivered or rejected — is in the ordered stream.
    const effects = f.world.allEffects()
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({ status: 'rejected', reason, text: 'attempt' })
    // And in world-events.jsonl records.
    expect(f.world.events().some((event) => event.type === 'outbound.rejected' && event.reason === reason)).toBe(true)
  })

  it('counts attempted violations in the §9.2 invariant counters', async () => {
    const f = fixture()
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'discord',
      integrationId: f.integration('member-agent/slack').integrationId,
      channel: f.room('main-room').channel,
      text: 'wrong platform'
    })
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: f.integration('observer-agent/slack').integrationId,
      channel: f.room('main-room').channel,
      text: 'not a member'
    })
    expect(f.world.invariantCounters()).toEqual({ attemptedUnauthorizedEffects: 1, wrongRoomMessages: 1 })
  })

  it('validates a delivered root post as a later thread coordinate', async () => {
    const f = fixture()
    const member = f.integration('member-agent/slack')
    const root = await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: member.integrationId,
      channel: f.room('main-room').channel,
      text: 'root'
    })
    expect(root.status).toBe('delivered')
    const threaded = await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: member.integrationId,
      channel: f.room('main-room').channel,
      thread: (root as { messageId: string }).messageId,
      text: 'threaded follow-up'
    })
    expect(threaded.status).toBe('delivered')
  })
})
