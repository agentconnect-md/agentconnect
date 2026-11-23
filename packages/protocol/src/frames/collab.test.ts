import { describe, it, expect } from 'vitest'
import { CollabAgentPlacement, CollabChannelRoute, CollabOrgAgent, CollabRoutesSnapshot } from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'

describe('CollabAgentPlacement & CollabRoutesSnapshot schemas', () => {
  it('accepts optional botUsername without leading @ on channel placements and preserves it on snapshot parse', () => {
    const placement = CollabAgentPlacement.parse({
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID,
      botAppId: 'mm-0123456789abcdef',
      botUserId: 'mmuser1234567890abcdefghij',
      botUsername: 'acbot',
      name: 'helper'
    })
    expect(placement.botUsername).toBe('acbot')

    const snap = CollabRoutesSnapshot.parse({
      generation: 3,
      channels: [
        {
          orgId: 'org_test',
          platform: 'mattermost',
          channelId: 'mmchan1234567890abcdefghij',
          agents: [placement]
        }
      ]
    })
    expect(snap.channels[0]?.agents[0]?.botUsername).toBe('acbot')
  })

  it('remains backward-compatible when botUsername is omitted and rejects non-string values', () => {
    const route = CollabChannelRoute.parse({
      orgId: 'org_test',
      platform: 'slack',
      channelId: 'C123',
      agents: [{ agentId: AGENT_ID, daemonId: DAEMON_ID }]
    })
    expect(route.agents[0]?.botUsername).toBeUndefined()

    const orgAgent = CollabOrgAgent.parse({ orgId: 'org_test', agentId: AGENT_ID })
    expect(orgAgent.botUsername).toBeUndefined()

    expect(CollabAgentPlacement.safeParse({ agentId: AGENT_ID, daemonId: DAEMON_ID, botUsername: 123 }).success).toBe(
      false
    )
  })
})
