import { describe, it, expect } from 'vitest'
import { CollabRoutesSnapshot } from '@agentconnect.md/protocol'
import { buildCollabSnapshot } from './collabSnapshot.js'
import type { ChannelPlacementRecord } from '../persistence/ports.js'
import { AgentId, IntegrationId } from '../domain/ids.js'
import { DEFAULT_ORG_ID } from '../config/defaults.js'

const DAEMON_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DAEMON_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT_1 = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const AGENT_2 = AgentId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const INTEGRATION = IntegrationId('ffffffff-ffff-4fff-8fff-ffffffffffff')

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
      7
    )
    // Regression: register/ok must remain wire-valid for the real opaque org-id
    // domain; UUID-only fixtures previously hid this production failure.
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    expect(snap.generation).toBe(7)
    expect(snap.channels).toHaveLength(1)
    expect(snap.channels[0]).toMatchObject({ orgId: DEFAULT_ORG_ID, platform: 'slack', channelId: 'C1' })
    expect(snap.channels[0].agents.map((a) => a.daemonId).sort()).toEqual([DAEMON_1, DAEMON_2].sort())
    expect(snap.channels[0].agents.map((a) => a.botAppId).sort()).toEqual(['A111', 'A222'])
  })

  it('drops unplaced agents (daemonId null) — they are not routable', () => {
    const snap = buildCollabSnapshot(DEFAULT_ORG_ID, [rec({ daemonId: null })], 1)
    expect(snap.channels).toHaveLength(0)
  })

  it('separates distinct channels', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [rec({ channelId: 'C1' }), rec({ channelId: 'C2', agentId: AGENT_2 })],
      1
    )
    expect(snap.channels.map((c) => c.channelId).sort()).toEqual(['C1', 'C2'])
  })

  it('carries the agent name + displayName so a peer daemon can label it in a visible post', () => {
    const snap = buildCollabSnapshot(
      DEFAULT_ORG_ID,
      [rec({ agentId: AGENT_1, name: 'deploy-bot', displayName: 'Deploy Bot' })],
      1
    )
    expect(CollabRoutesSnapshot.parse(snap)).toEqual(snap)
    expect(snap.channels[0].agents[0]).toMatchObject({ name: 'deploy-bot', displayName: 'Deploy Bot' })
  })
})
