import { describe, it, expect } from 'vitest'
import { CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { buildCollabSnapshot } from './collabSnapshot.js'
import type { ChannelPlacementRecord, OrgAgentRecord } from '../persistence/ports.js'
import { AgentId, IntegrationId } from '../domain/ids.js'
import { DEFAULT_ORG_ID } from '../config/defaults.js'

const DAEMON_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DAEMON_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT_1 = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const AGENT_2 = AgentId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const AGENT_3 = AgentId('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
const INTEGRATION = IntegrationId('ffffffff-ffff-4fff-8fff-ffffffffffff')

function orgAgent(over: Partial<OrgAgentRecord>): OrgAgentRecord {
  return {
    agentId: AGENT_1,
    name: 'agent-one',
    displayName: null,
    description: null,
    status: 'active',
    placementKind: 'daemon',
    daemonId: DAEMON_1,
    setId: null,
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    ...over
  }
}

function rec(over: Partial<ChannelPlacementRecord>): ChannelPlacementRecord {
  return {
    platform: 'slack',
    channelId: 'C1',
    agentId: AGENT_1,
    daemonId: DAEMON_1,
    integrationId: INTEGRATION,
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    name: 'agent-one',
    ...over
  }
}

describe('buildCollabSnapshot (agent-collaboration P2)', () => {
  it('groups placements by channel and carries daemon, integration, and public bot app identity', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [
        rec({ agentId: AGENT_1, daemonId: DAEMON_1, botAppId: 'A111' }),
        rec({ agentId: AGENT_2, daemonId: DAEMON_2, botAppId: 'A222' })
      ],
      7,
      []
    )
    // Regression: register/ok must remain wire-valid for the real opaque org-id
    // domain; UUID-only fixtures previously hid this production failure.
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    expect(snap.generation).toBe(7)
    expect(snap.channels).toHaveLength(1)
    expect(snap.channels[0]).toMatchObject({ orgId: DEFAULT_ORG_ID, platform: 'slack', channelId: 'C1' })
    expect(snap.channels[0]!.agents.map((a) => a.daemonId).sort()).toEqual([DAEMON_1, DAEMON_2].sort())
    expect(snap.channels[0]!.agents.map((a) => a.botAppId).sort()).toEqual(['A111', 'A222'])
    // §6.1: every snapshot ships the emitter's origin-kind classification so an older
    // peer can classify a platform id this CP introduces.
    expect(snap.platformKinds).toEqual(
      expect.arrayContaining([
        { platformId: 'slack', originKind: 'chat' },
        { platformId: 'feishu', originKind: 'chat' },
        { platformId: 'webchat', originKind: 'webchat' },
        { platformId: 'hook', originKind: 'hook' },
        { platformId: 'dream', originKind: 'dream' }
      ])
    )
  })

  it('derives channel-scoped mention sharing from actual identities, and omits mention inputs org-wide', () => {
    // send-message-routing-rework.md §8.5: an agent's `@mention` is only meaningful
    // inside a conversation — the bot user id resolves relative to that channel's
    // membership, and a shared bot needs the agent slug to be addressable at all. So the
    // inputs ride on the CHANNEL entries and are deliberately absent from the flat
    // org-wide directory, which has no single conversation-specific address to offer.
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [
        rec({ agentId: AGENT_1, botUserId: 'U01DEDICATED' }),
        rec({ agentId: AGENT_2, botUserId: 'U09SHARED', name: 'reviewer' }),
        rec({ agentId: AGENT_3, botUserId: 'U09SHARED', name: 'planner' })
      ],
      1,
      [orgAgent({ agentId: AGENT_1 })]
    )
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    const byAgent = new Map(snap.channels[0]!.agents.map((a) => [a.agentId, a]))
    expect(byAgent.get(AGENT_1)).toMatchObject({ botUserId: 'U01DEDICATED' })
    expect(byAgent.get(AGENT_1)!.botShared).toBeUndefined()
    expect(byAgent.get(AGENT_2)).toMatchObject({ botUserId: 'U09SHARED', botShared: true, name: 'reviewer' })
    expect(byAgent.get(AGENT_3)).toMatchObject({ botUserId: 'U09SHARED', botShared: true, name: 'planner' })
    expect(snap.agents[0]!.botUserId).toBeUndefined()
    expect(snap.agents[0]!.botShared).toBeUndefined()
  })

  it('does not confuse a bot sharing capability with sharing its identity in this channel', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [
        rec({ channelId: 'C1', agentId: AGENT_1, botUserId: 'U09CAPABLE' }),
        rec({ channelId: 'C2', agentId: AGENT_2, botUserId: 'U09CAPABLE' })
      ],
      1,
      []
    )
    expect(snap.channels.flatMap((channel) => channel.agents).every((agent) => agent.botShared === undefined)).toBe(
      true
    )
  })

  it('drops unplaced agents (daemonId null) — they are not routable', () => {
    const snap = buildCollabSnapshot(DEFAULT_ORG_ID, [rec({ daemonId: null })], 1, [])
    expect(snap.channels).toHaveLength(0)
  })

  it('separates distinct channels', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [rec({ channelId: 'C1' }), rec({ channelId: 'C2', agentId: AGENT_2 })],
      1,
      []
    )
    expect(snap.channels.map((c) => c.channelId).sort()).toEqual(['C1', 'C2'])
  })

  it('carries the agent name + displayName so a peer daemon can label it in a visible post', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [rec({ agentId: AGENT_1, name: 'deploy-bot', displayName: 'Deploy Bot' })],
      1,
      []
    )
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    expect(snap.channels[0]!.agents[0]).toMatchObject({ name: 'deploy-bot', displayName: 'Deploy Bot' })
  })

  it('carries an integration-less agent in the flat org directory (the whole point of agents[])', () => {
    // AGENT_1 reaches a channel; AGENT_3 has NO integration at all, so it appears in
    // zero channels[] entries — the flat list is its only carrier.
    const snap = buildCollabSnapshot(DEFAULT_ORG_ID, [rec({ agentId: AGENT_1 })], 3, [
      orgAgent({ agentId: AGENT_1, name: 'deploy-bot', displayName: 'Deploy Bot' }),
      orgAgent({
        agentId: AGENT_3,
        name: 'webchat-only',
        daemonId: DAEMON_2,
        callPolicy: 'selected',
        allowedCallerAgentIds: [AGENT_1]
      })
    ])
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    expect(snap.channels.flatMap((c) => c.agents).map((a) => a.agentId)).toEqual([AGENT_1])
    expect(snap.agents.map((a) => a.agentId).sort()).toEqual([AGENT_1, AGENT_3].sort())
    expect(snap.agents.find((a) => a.agentId === AGENT_3)).toEqual({
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT_3,
      daemonId: DAEMON_2,
      name: 'webchat-only',
      callPolicy: 'selected',
      allowedCallerAgentIds: [AGENT_1],
      outboundPolicy: 'all',
      allowedTargetAgentIds: []
    })
    // displayName is omitted (not null) when unset, and set when present.
    expect(snap.agents.find((a) => a.agentId === AGENT_1)?.displayName).toBe('Deploy Bot')
  })

  // A `set` (pool) agent's `Agent.daemonId` is null by design; only the resolved directory names
  // its holder (agent-collaboration-implementation.md §"Collaboration-routing snapshot").
  it('places a pool agent in its channels from the resolved directory, not the null placement column', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [
        rec({ agentId: AGENT_1, daemonId: DAEMON_1, botUserId: 'U09SHARED', name: 'machine-placed' }),
        // Pool-placed: no machine on the row, and a live member holds it.
        rec({ agentId: AGENT_2, daemonId: null, botUserId: 'U09SHARED', name: 'pool-placed' })
      ],
      1,
      [orgAgent({ agentId: AGENT_1, daemonId: DAEMON_1 }), orgAgent({ agentId: AGENT_2, daemonId: DAEMON_2 })]
    )
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    const byAgent = new Map(snap.channels[0]!.agents.map((a) => [a.agentId, a]))
    // The membership `coordsDecision` reads — both halves now agree on who serves AGENT_2.
    expect([...byAgent.keys()].sort()).toEqual([AGENT_1, AGENT_2].sort())
    expect(byAgent.get(AGENT_2)).toMatchObject({ daemonId: DAEMON_2, name: 'pool-placed' })
    // Mention sharing counts it too: it was invisible to that derivation for the same reason.
    expect(byAgent.get(AGENT_1)).toMatchObject({ botShared: true })
    expect(byAgent.get(AGENT_2)).toMatchObject({ botShared: true })
  })

  it('still drops a PENDING pool agent from channels[] — that half carries no daemon-less entry', () => {
    // The wire contract keeps pending entries to the flat directory, so a wake at an
    // unconfirmed grant gets the retryable `not_ready` from there rather than a channel row
    // naming a daemon that would refuse it.
    const snap = buildCollabSnapshot(DEFAULT_ORG_ID, [rec({ agentId: AGENT_2, daemonId: null })], 1, [
      orgAgent({ agentId: AGENT_2, daemonId: null })
    ])
    expect(snap.channels).toHaveLength(0)
    expect(snap.agents.map((a) => a.agentId)).toEqual([AGENT_2])
  })

  // The resolver already dropped what nothing serves; a null daemon here is a PENDING pool
  // agent, carried without a daemon so a wake gets the retryable `not_ready` (#987).
  it('carries a pending (daemon-less) directory row without a daemonId', () => {
    const snap = buildCollabSnapshot(DEFAULT_ORG_ID, [], 1, [orgAgent({ agentId: AGENT_3, daemonId: null })])
    expect(snap.agents).toHaveLength(1)
    expect(snap.agents[0]).toMatchObject({ agentId: AGENT_3, orgId: DEFAULT_ORG_ID })
    expect(snap.agents[0]).not.toHaveProperty('daemonId')
  })
})
